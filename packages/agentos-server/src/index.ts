// Combined server: AgentOS dashboard API + observability read API.
//
// Surface (see app.ts for the full tree):
//   /agentos/api/v1/login, /logout, /me   — PUBLIC
//   /agentos/api/v1/health, /v1/health     — PUBLIC
//   /agentos/api/v1/*                      — GATED (dashboard)
//   /v1/*                                  — GATED (observability)
//   /agentos/api/ingest/*, /agentos/api/keys/*  — service bearer guards
//
// Talks to:
//   - ComputerAgent harness (CA_BASE) for sandbox/run/artifact
//   - MongoDB / DocumentDB (MONGO_URL) for registry, threads, sessions, logs,
//     schedules
//   - Trace store, selected by TRACE_BACKEND env var (clickhouse | newrelic)
//
// This file owns only env + listen + one-time bootstrap; the Express wiring
// lives in app.ts (buildApp).

// MUST be the first import — loads .env files before anything reads process.env.
import "./load-env.js";

import { buildApp } from "./app.js";

import { pingClickHouse } from "./clickhouse.js";
import { pingNewRelic } from "./new-relic.js";
import { pingMongo, migrateLegacyWebSessions, migrateRegistryObjectIds, ensureRegistryIndexes } from "./mongo.js";
import { apiKeyStore } from "./stores/api-key-store.js";
import { gitCredentialStore } from "./stores/git-credential-store.js";
import { roleStore } from "./stores/role-store.js";
import { ensureFieldValueMVs } from "./migrations.js";
import { startScheduler } from "./scheduler.js";
import { seedDefaultAgentIfRequested } from "./agent-defs.js";
import { traceBackend } from "./trace-backend.js";

const app = buildApp();

// Use AGENTOS_PORT (not PORT) so the harness and this server can coexist in
// one .env file — the harness uses PORT for its own listener.
const PORT = parseInt(process.env["AGENTOS_PORT"] ?? "8788", 10);
app.listen(PORT, async () => {
  console.log(`[agentos-server] listening on http://localhost:${PORT}`);
  console.log(`[agentos-server] CA_BASE=${process.env["CA_BASE"] ?? "http://127.0.0.1:8787"}`);

  // The telemetry ingest route bypasses the dashboard's auth and mutates
  // dashboard-visible data (registry/logs/sessions). When its token is unset it
  // is fully open — fine behind a network policy / on loopback, but a sharp edge
  // on an exposed pod. Warn loudly so it's a deliberate choice.
  if (!process.env["AGENTOS_INGEST_TOKEN"]) {
    console.warn(
      "[agentos-server] WARNING: AGENTOS_INGEST_TOKEN unset — POST /agentos/api/ingest/events is OPEN " +
        "(anonymous writes to agent_registry/agent_logs/sessions/agent_messages). " +
        "Set AGENTOS_INGEST_TOKEN on any network-exposed deployment.",
    );
  }

  // API-key introspection fails CLOSED: when the secret is unset the endpoint
  // returns 503, so the ComputerAgent server cannot validate keys and API-key
  // auth is effectively unavailable. Flag it so it's a deliberate choice.
  if (!process.env["AGENTOS_INTROSPECTION_SECRET"]) {
    console.warn(
      "[agentos-server] WARNING: AGENTOS_INTROSPECTION_SECRET unset — POST /agentos/api/keys/introspect " +
        "returns 503, so the ComputerAgent server cannot validate API keys. " +
        "Set it (and the same value on the ComputerAgent server) to enable API-key auth.",
    );
  }

  const backend = traceBackend();
  console.log(`[agentos-server] trace backend: ${backend}`);

  // Ping the active trace backend in parallel with Mongo. The OTHER backend
  // can still be reachable during dual-export, but we only block on the one
  // routes actually call.
  const traceProbe = backend === "newrelic" ? pingNewRelic() : pingClickHouse();
  const [mongoOk, traceOk] = await Promise.all([pingMongo(), traceProbe]);
  console.log(`[agentos-server] mongo: ${mongoOk ? "up" : "DOWN (check MONGO_URL)"}`);
  console.log(
    `[agentos-server] ${backend}: ${traceOk ? "up" : `DOWN (check ${backend === "newrelic" ? "NEW_RELIC_USER_API_KEY/ACCOUNT_ID" : "CLICKHOUSE_URL"})`}`,
  );

  // ClickHouse MVs — only relevant when TRACE_BACKEND=clickhouse. Best-effort.
  if (backend === "clickhouse" && traceOk) {
    try {
      const result = await ensureFieldValueMVs();
      if (result.status === "skipped") {
        console.warn(`[agentos-server] obs MV bootstrap skipped: ${result.reason}`);
      } else if (result.status === "created-and-backfilled") {
        console.log("[agentos-server] obs MVs created + backfilled");
      } else {
        console.log("[agentos-server] obs MVs ready");
      }
    } catch (err) {
      console.warn("[agentos-server] obs MV bootstrap failed:", (err as Error).message);
    }
  }

  // Mongo-side bootstrap — seed default agent and start the scheduler tick.
  if (mongoOk) {
    // One-time, idempotent: convert legacy `_id == name` rows in agent_registry
    // / chat_pins / agent_policies to surrogate ObjectId `_id` + name field,
    // then ensure the unique name indexes. Runs before everything else so new
    // writes (seed, ingest) land in the ObjectId world.
    try {
      const m = await migrateRegistryObjectIds();
      if (m.registry || m.pins || m.policies) {
        console.log(`[agentos-server] migrated registry ids — registry:${m.registry} pins:${m.pins} policies:${m.policies}`);
      }
      await ensureRegistryIndexes();
      await apiKeyStore.ensureIndexes();
      await gitCredentialStore.ensureIndexes();
      await roleStore.seedDefaults(); // idempotent: agentos-admin/editor/viewer
    } catch (err) {
      console.warn("[agentos-server] registry id migration/index failed:", (err as Error).message);
    }
    try {
      await seedDefaultAgentIfRequested();
    } catch (err) {
      console.warn("[agentos-server] seed failed:", (err as Error).message);
    }
    // One-time, idempotent: migrate legacy web chat rows out of slack_threads
    // into the dedicated chat_sessions collection so existing sessions keep
    // showing after the decoupling.
    try {
      const n = await migrateLegacyWebSessions();
      if (n > 0) console.log(`[agentos-server] backfilled ${n} web session(s) into chat_sessions`);
    } catch (err) {
      console.warn("[agentos-server] chat_sessions backfill failed:", (err as Error).message);
    }
    startScheduler();
  }
});
