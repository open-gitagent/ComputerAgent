/**
 * OpenTelemetry observability — localhost + claude-agent-sdk engine demo,
 * designed to pair with the `docker-compose.yml` collector in this folder.
 *
 *   # standalone (console exporter — no collector needed)
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     bun run examples/otel-collector/otel-localhost-claude.ts
 *
 *   # against the bundled OTLP collector (recommended)
 *   docker compose -f examples/otel-collector/docker-compose.yml up -d
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *     ANTHROPIC_API_KEY=sk-ant-... \
 *     bun run examples/otel-collector/otel-localhost-claude.ts
 *
 * What this shows:
 *   1. Boot `createHarnessServer` on 127.0.0.1 with the claude-agent-sdk
 *      engine and a `GitAgentProtocolLoader`.
 *   2. Wire `@computeragent/observability`'s `OtelAuditSink` so every harness
 *      event becomes a spec-compliant `gen_ai.*` span. Exporter chosen
 *      automatically: `otlp-http` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set,
 *      `console` otherwise.
 *   3. Drive the harness with plain HTTP — POST /v1/chat with an inline GAP
 *      agent, stream the SSE response, fetch the artifact, print usage.
 *   4. Tear down: shutdown the OTel pipeline (flush exporters), close the
 *      server.
 *
 * The resulting trace tree (visible in the collector's debug exporter or
 * the console output):
 *
 *   invoke_agent <agent.name>     [gen_ai.conversation.id = sessionId]
 *   └── chat <model>
 *       └── execute_tool Write   ← the tool Claude calls to produce haiku.txt
 *
 * All attributes follow the OpenTelemetry GenAI Semantic Conventions
 * (semconv v1.40). Cost is recorded under `computeragent.usage.cost_usd`
 * since the spec defines no cost key.
 */
import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { configure, shutdown, OtelAuditSink } from "@computeragent/observability";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY first.");
  process.exit(1);
}

// 1. Initialize the OTel pipeline. If OTEL_EXPORTER_OTLP_ENDPOINT is set
//    (typically by `docker compose up` against the collector in this folder),
//    route spans + metrics + logs via OTLP/HTTP to it. Otherwise fall back
//    to the console exporter so the demo still works standalone.
//
//    captureContent is ON for this demo so you can see real prompts, model
//    responses, tool args, and tool results land on the spans. Default mode
//    "events" routes them through `gen_ai.client.inference.operation.details`
//    log records (spec-preferred for high-volume content) — the collector
//    bundled here ingests OTLP/logs on the same endpoint, no extra setup.
//    Redaction stays OFF for demo readability; flip it on for anything you
//    might ever share.
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
configure({
  serviceName: "computeragent-otel-demo",
  ...(otlpEndpoint
    ? { exporter: "otlp-http" as const, endpoint: otlpEndpoint }
    : { exporter: "console" as const }),
  sampleRate: 1.0,
  captureContent: true,
  captureContentMode: "both",
  maxAttributeLength: 8192,
});
console.log(
  otlpEndpoint
    ? `OTel: exporting to OTLP/HTTP at ${otlpEndpoint} (content capture: ON, mode=both)`
    : `OTel: exporting to console (content capture: ON, mode=both)`,
);

// 2. Boot the harness server with the new audit sink wired in.
const app = createHarnessServer({
  engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  auditSink: new OtelAuditSink(),
});

const port = 7800 + Math.floor(Math.random() * 100);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
console.log(`harness-server listening on ${base}\n`);

try {
  // 3. Drive it via plain HTTP — POST /v1/chat with an inline agent.
  const body = {
    engine: "claude-agent-sdk",
    identity: {
      loader: "gitagentprotocol",
      source: {
        type: "inline" as const,
        manifest: { name: "otel-haiku-bot", version: "0.1.0" },
        files: {
          "agent.yaml": [
            'spec_version: "0.1.0"',
            "name: otel-haiku-bot",
            "version: 0.1.0",
            "model:",
            "  preferred: claude-haiku-4-5-20251001",
            "runtime:",
            "  max_turns: 2",
          ].join("\n"),
          "SOUL.md":
            "Write the requested content to the requested file using the Write tool. Stay terse.",
        },
      },
    },
    envs: { ANTHROPIC_API_KEY },
    messages: [{ role: "user", content: 'Write a 3-line haiku about TypeScript to "haiku.txt".' }],
    options: { permissionMode: "bypassPermissions" },
  };

  const res = await fetch(`${base}/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`POST /v1/chat failed: ${res.status} ${await res.text()}`);
  }

  let sessionId = "";
  let haiku = "";
  let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;

  // 4. Stream SSE. Parse each `event:\ndata:\n\n` frame and react to the
  // ones we care about. The OtelAuditSink is already producing spans
  // server-side; this client loop is just for the demo printout.
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evMatch = frame.match(/^event: (.+)$/m);
      const dataMatch = frame.match(/^data: (.+)$/m);
      if (!evMatch || !dataMatch) continue;
      const data = JSON.parse(dataMatch[1] ?? "{}");
      const kind = evMatch[1];

      if (kind === "ca_session_started") {
        sessionId = data.sessionId;
        console.log(`session: ${sessionId}`);
      } else if (kind === "ca_turn_started") {
        console.log(`turn ${data.turnIndex} started`);
      } else if (kind === "sdk_message" && data.payload?.type === "user") {
        // tool_result arrives as type:"user" with content[].type:"tool_result".
        // Once we see one, fetch the file the agent wrote.
        if (!haiku && sessionId) {
          const file = await fetch(`${base}/v1/sessions/${sessionId}/fs/read?path=haiku.txt`);
          if (file.ok) haiku = await file.text();
        }
      } else if (kind === "ca_usage_snapshot") {
        usage = data;
      } else if (kind === "ca_session_ended") {
        console.log(`session ended: ${data.reason}`);
      }
    }
  }

  console.log(`\n${haiku || "(no file produced)"}\n`);
  console.log(
    `${(usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0)} tokens • ` +
      `$${usage?.costUsd?.toFixed(4) ?? "?"} • ` +
      `session ${sessionId}\n`,
  );
  console.log("(scroll up: invoke_agent → chat → execute_tool spans printed by the console exporter)");
} finally {
  // 5. Tear down. Flush OTel exporters before closing the server so the
  //    final spans actually land on stderr.
  await shutdown(2_000);
  server.close();
}
