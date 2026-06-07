// Telemetry ingest — receives batches of TelemetryEvents POSTed by the Python
// SDK's AgentOSHttpSink and projects each into MongoDB (registry / logs /
// sessions / chat_sessions / agent_messages). Mounted at /agentos/api/ingest
// with its own bearer-token guard (see ingest-auth.ts), bypassing the
// cookie/Basic dashboard auth.

import { Router, type Router as IRouter } from "express";
import { projectEvent, type IngestEvent } from "../stores/telemetry-projection.js";
import { srsPolicyForAgent } from "../agent-defs.js";

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

// SRS reverse-proxy for library-mode (Python) SDKs. The SDK authenticates with
// the ingest bearer token and never sees the SRS key or endpoint — agentos
// injects them server-side here, mirroring the dashboard proxy in policies.ts.
const SRS_BASE = (process.env["SRS_BASE_URL"] ?? "").replace(/\/+$/, "");
const SRS_KEY = process.env["SRS_API_KEY"] ?? "";

async function forwardToSrs(
  res: import("express").Response,
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  if (!SRS_BASE) {
    res.status(503).json({
      error: { code: "SRS_NOT_CONFIGURED", message: "Policy service (SRS) is not configured." },
    });
    return;
  }
  try {
    const r = await fetch(`${SRS_BASE}${path}`, {
      method,
      headers: {
        "x-api-key": SRS_KEY,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }
    res.status(r.status).json(parsed);
  } catch (err) {
    res.status(502).json({ error: { code: "SRS_UNREACHABLE", message: (err as Error).message } });
  }
}

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
    agent_id: typeof r["agent_id"] === "string" && r["agent_id"] ? r["agent_id"] : null,
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

// Policy config for an agent — lets the library-mode Python SDK learn *which*
// policy is bound to an agent, over the ingest channel. Returns ONLY the binding
// (policyId + principalId), never the SRS endpoint/api key: the SDK reaches SRS
// exclusively through the proxy routes below, so the key stays server-side.
ingestRouter.get("/policy-config/:name", async (req, res, next) => {
  try {
    const policy = await srsPolicyForAgent(req.params["name"]!);
    if (!policy || !policy["policyId"]) {
      res.json({ policy: null });
      return;
    }
    res.json({ policy: { policyId: policy["policyId"], principalId: policy["principalId"] } });
  } catch (err) {
    next(err);
  }
});

// SRS proxy (ingest-token auth, key injected server-side). The Python SDK
// fetches a bound RAI policy's guardrail config and evaluates each tool call
// without ever holding the SRS key or a network path to SRS.
ingestRouter.get("/rai/policies/:id", (req, res) =>
  forwardToSrs(res, "GET", `/v1/rai/policies/${encodeURIComponent(req.params["id"]!)}`),
);
ingestRouter.post("/guardrails/evaluate-tool-call", (req, res) =>
  forwardToSrs(res, "POST", "/v1/guardrails/evaluate-tool-call", req.body ?? {}),
);
