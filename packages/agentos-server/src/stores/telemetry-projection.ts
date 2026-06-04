// Telemetry projection — write the Mongo docs the AgentOS dashboard reads from
// a stream of TelemetryEvents POSTed by the Python SDK's AgentOSHttpSink.
//
// This is the server-side port of the two Python sinks that used to write Mongo
// directly (AgentRegistrySink + MongoMessageSink). The wire payload IS the
// serialized TelemetryEvent, so this reads the exact same `payload` keys the
// sinks read. Differences from the Python version, all deliberate:
//   - writes the canonical `chat_sessions` row (the collection the dashboard
//     list + per-agent sessionCount actually read) — Python never did, so
//     library sessions never showed up;
//   - drops the dead `slack_threads` write;
//   - derives `_id`s from the event_id so a retried batch is idempotent
//     (Python used random uuids → duplicates on retry);
//   - persists the opening prompt on the session doc's `meta` so session_ended
//     can recover it for the log `query` (Python kept it in process memory).

import { createHash } from "node:crypto";
import {
  chatSessionsColl,
  messagesColl,
  registryColl,
  sessionsColl,
  type MessageDoc,
} from "../mongo.js";
import { agentLogStore, type NewAgentLog } from "./agent-log-store.js";
import { bareModelName, inlineSourceFor, librarySourceFor } from "../agent-source.js";

// Truncation caps — match the Python sinks exactly so docs from either runtime
// share a shape.
export const QUERY_MAX = 8_000;
export const REPLY_MAX = 16_000;
export const MSG_MAX = 32_000;

const SOURCE = "library";

export interface IngestEvent {
  event_id: string;
  kind: string;
  session_id: string;
  timestamp: string; // ISO-8601
  agent_name: string | null;
  agent_description: string | null;
  host?: string | null;
  payload: Record<string, unknown>;
}

// ── helpers ────────────────────────────────────────────────────────────────

/** Plain slice (no footer) — matches AgentRegistrySink._truncate. */
function truncateStr(s: unknown, n: number): string {
  const str = typeof s === "string" ? s : String(s ?? "");
  return str.length <= n ? str : str.slice(0, n);
}

/** Recursive, footer-annotated — matches MongoMessageSink._truncate. */
function truncatePayload(value: unknown, limit: number): unknown {
  if (Array.isArray(value)) return value.map((v) => truncatePayload(v, limit));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncatePayload(v, limit);
    return out;
  }
  if (typeof value === "string" && value.length > limit) {
    return value.slice(0, limit) + `…(+${value.length - limit} chars)`;
  }
  return value;
}

function tsFromEvent(ev: IngestEvent): Date {
  if (!ev.timestamp) return new Date();
  const d = new Date(ev.timestamp);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Fallback agent name when none was supplied — matches _agent_name_from_event. */
function anonymousName(ev: IngestEvent): string {
  const p = ev.payload ?? {};
  const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
  const model = typeof p["model"] === "string" ? p["model"] : "";
  const h = createHash("sha256").update(`${model}|${prompt}`).digest("hex").slice(0, 12);
  return `anonymous-${h}`;
}

// ── projection ───────────────────────────────────────────────────────────────

/** Project one event into MongoDB. Idempotent per `event_id`. */
export async function projectEvent(ev: IngestEvent): Promise<void> {
  // 1. agent_messages — every kind except the two rollups (AgentRegistrySink
  //    owns those via agent_logs / the session doc).
  if (ev.kind !== "session_started" && ev.kind !== "session_ended") {
    await writeMessage(ev);
  }

  // 2. routed writes
  switch (ev.kind) {
    case "session_started":
      await onSessionStarted(ev);
      break;
    case "session_ended":
      await onSessionEnded(ev);
      break;
    case "assistant_message":
      await appendEntry(ev, "assistant", ev.payload?.["text"]);
      break;
    case "user_message":
      await appendEntry(ev, "user", ev.payload?.["text"]);
      break;
    default:
      // every other kind is captured by the agent_messages write above
      break;
  }
}

async function writeMessage(ev: IngestEvent): Promise<void> {
  const doc: MessageDoc = {
    _id: `msg_${ev.event_id}`,
    ts: tsFromEvent(ev),
    source: SOURCE,
    host: ev.host ?? null,
    sessionId: ev.session_id,
    agentName: ev.agent_name,
    kind: ev.kind,
    payload: truncatePayload(ev.payload ?? {}, MSG_MAX),
  };
  const latency = (ev.payload ?? {})["latency_ms"];
  if (typeof latency === "number") doc.latencyMs = latency;
  // $setOnInsert keyed on the deterministic _id → a replayed batch is a no-op.
  await (await messagesColl()).updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
}

async function onSessionStarted(ev: IngestEvent): Promise<void> {
  const now = tsFromEvent(ev);
  const name = ev.agent_name || anonymousName(ev);
  const description = ev.agent_description ?? "";
  const payload = ev.payload ?? {};
  const model = bareModelName(payload["model"]);
  const source = payload["harness_mode"]
    ? librarySourceFor(name, payload, description)
    : inlineSourceFor(name, payload, description);

  // agent_registry upsert (idempotent on agent name).
  await (await registryColl()).updateOne(
    { _id: name },
    {
      $setOnInsert: { _id: name, registeredAt: now },
      $set: {
        harness: "claude-agent-sdk",
        source,
        model: model ?? undefined,
        registeredBy: ev.host ?? undefined,
        updatedAt: now,
        lastSeen: now,
      },
    },
    { upsert: true },
  );

  // sessions open upsert — `meta.prompt` lets session_ended recover the query.
  const prompt = typeof payload["prompt"] === "string" ? (payload["prompt"] as string) : "";
  const openRes = await (await sessionsColl()).updateOne(
    { _id: ev.session_id },
    {
      $setOnInsert: {
        _id: ev.session_id,
        createdAt: now,
        entries: [],
        meta: { prompt, model, startedAt: now },
      },
      $set: {
        agentName: name,
        source: SOURCE,
        model,
        updatedAt: now,
      },
    },
    { upsert: true },
  );

  // chat_sessions upsert — the collection GET /sessions and GET /agents read.
  await (await chatSessionsColl()).updateOne(
    { _id: ev.session_id },
    {
      $setOnInsert: { _id: ev.session_id, createdAt: now },
      $set: { agent: name, lastMessageAt: now },
    },
    { upsert: true },
  );

  // Seed the first user entry from the prompt — but only when we actually
  // created the session doc this call (Mongo-atomic, cross-process safe).
  if ((openRes.upsertedCount ?? 0) > 0 && prompt) {
    await pushEntry(ev.session_id, { type: "user", text: truncateStr(prompt, REPLY_MAX) }, now);
  }
}

async function onSessionEnded(ev: IngestEvent): Promise<void> {
  const now = tsFromEvent(ev);
  const payload = ev.payload ?? {};
  const sessions = await sessionsColl();
  const sessionDoc = await sessions.findOne({ _id: ev.session_id });
  const name = ev.agent_name || sessionDoc?.agentName || anonymousName(ev);
  const usage = (payload["usage"] as Record<string, unknown> | undefined) ?? {};
  const isError = !!payload["is_error"];

  const log: NewAgentLog = {
    _id: `log_${ev.event_id}`,
    ts: now,
    source: SOURCE,
    // `bot` is the per-agent count key; `agentName` is the parallel field.
    bot: name,
    agentName: name,
    requester: ev.host ?? "",
    channel: null,
    threadTs: null,
    sessionId: ev.session_id,
    query: truncateStr(sessionDoc?.meta?.prompt ?? "", QUERY_MAX),
    reply: truncateStr(payload["result"], REPLY_MAX),
    ok: !isError,
  };
  if (isError) {
    log.error = String(payload["error_message"] ?? payload["subtype"] ?? "");
  }
  if (typeof payload["duration_ms"] === "number") {
    log.durationMs = Math.trunc(payload["duration_ms"] as number);
  }
  if (typeof usage["input_tokens"] === "number") log.inputTokens = usage["input_tokens"] as number;
  if (typeof usage["output_tokens"] === "number") log.outputTokens = usage["output_tokens"] as number;
  if (payload["total_cost_usd"] != null) {
    const c = Number(payload["total_cost_usd"]);
    log.costUsd = Number.isFinite(c) ? c : null;
  }
  await agentLogStore.append(log);

  // sessions close — stamp end metadata, don't append to entries. NO upsert:
  // session_started is the sole creator of the session doc. If the start event
  // was dropped/reordered, this close must NOT materialize a stub doc — a stub
  // (no meta/createdAt/entries) would make a later session_started's
  // $setOnInsert no-op and silently lose the prompt + seeded first turn.
  const close: Record<string, unknown> = { endedAt: now, updatedAt: now, ok: !isError };
  if (typeof payload["duration_ms"] === "number") close["durationMs"] = Math.trunc(payload["duration_ms"] as number);
  if (payload["total_cost_usd"] != null) {
    const c = Number(payload["total_cost_usd"]);
    if (Number.isFinite(c)) close["costUsd"] = c;
  }
  await sessions.updateOne({ _id: ev.session_id }, { $set: close });

  // chat_sessions bump — no upsert: a row with no `agent` is invisible to the
  // dashboard, so only bump when session_started already created it.
  await (await chatSessionsColl()).updateOne(
    { _id: ev.session_id },
    { $set: { lastMessageAt: now } },
  );
}

async function appendEntry(
  ev: IngestEvent,
  type: "user" | "assistant",
  textVal: unknown,
): Promise<void> {
  const text = typeof textVal === "string" ? textVal : "";
  if (!text) return; // matches the Python "skip empty text" behaviour
  const now = tsFromEvent(ev);
  await pushEntry(ev.session_id, { type, text: truncateStr(text, REPLY_MAX) }, now);
  await (await chatSessionsColl()).updateOne(
    { _id: ev.session_id },
    { $set: { lastMessageAt: now } },
  );
}

async function pushEntry(
  sessionId: string,
  entry: { type: string; text: string },
  now: Date,
): Promise<void> {
  // NO upsert — session_started creates the doc; an entry arriving before it
  // (dropped/reordered start) must no-op rather than stub the doc (see the
  // session-close note above). Normal in-order delivery always has the doc.
  await (await sessionsColl()).updateOne(
    { _id: sessionId },
    { $push: { entries: entry }, $set: { updatedAt: now } },
  );
}
