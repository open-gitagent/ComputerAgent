// Telemetry ingest — receives batches of TelemetryEvents POSTed by the Python
// SDK's AgentOSHttpSink and projects each into MongoDB (registry / logs /
// sessions / chat_sessions / agent_messages). Mounted at /agentos/api/ingest
// with its own bearer-token guard (see ingest-auth.ts), bypassing the
// cookie/Basic dashboard auth.

import { Router, type Router as IRouter } from "express";
import { projectEvent, type IngestEvent } from "../stores/telemetry-projection.js";

const KNOWN_KINDS = new Set([
  "session_started",
  "user_message",
  "assistant_message",
  "system_message",
  "tool_use",
  "tool_result",
  "usage_snapshot",
  "session_ended",
  "policy_decision",
]);

const MAX_BATCH = 500;

/** Validate + normalize one wire event. Returns null to skip (counted, not fatal). */
function coerce(raw: unknown): IngestEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r["kind"];
  const sessionId = r["session_id"];
  const eventId = r["event_id"];
  if (typeof kind !== "string" || typeof sessionId !== "string" || typeof eventId !== "string") {
    return null;
  }
  // Unknown kinds are skipped (not rejected) so a newer SDK can add event types
  // without a server deploy.
  if (!KNOWN_KINDS.has(kind)) return null;
  const payload = r["payload"];
  return {
    event_id: eventId,
    kind,
    session_id: sessionId,
    timestamp: typeof r["timestamp"] === "string" ? r["timestamp"] : "",
    agent_name: typeof r["agent_name"] === "string" ? r["agent_name"] : null,
    agent_description: typeof r["agent_description"] === "string" ? r["agent_description"] : null,
    host: typeof r["host"] === "string" ? r["host"] : null,
    payload:
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

export const ingestRouter: IRouter = Router();

ingestRouter.post("/events", async (req, res, next) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const events = body["events"];
    if (!Array.isArray(events)) {
      return res
        .status(400)
        .json({ error: { code: "BAD_REQUEST", message: "`events` array required" } });
    }
    if (events.length > MAX_BATCH) {
      return res
        .status(413)
        .json({ error: { code: "BATCH_TOO_LARGE", message: `max ${MAX_BATCH} events per batch` } });
    }

    let ingested = 0;
    let skipped = 0;
    // Project in array order so transcript entries land in the order they were
    // emitted. A single bad event never fails the batch.
    for (const raw of events) {
      const ev = coerce(raw);
      if (!ev) {
        skipped++;
        continue;
      }
      try {
        await projectEvent(ev);
        ingested++;
      } catch (err) {
        console.warn("[agentos-server] ingest projection failed:", (err as Error).message);
        skipped++;
      }
    }
    res.json({ ok: true, ingested, skipped });
  } catch (err) {
    next(err);
  }
});
