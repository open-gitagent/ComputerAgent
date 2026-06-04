/**
 * Standalone harness-server entry — speaks the `/v1/sessions/*` protocol
 * directly, no CAS wrapper.
 *
 * Used by the Python QA worker (enterprise-computeragent/deploy/fullstack-base/
 * worker-python) via `ComputerAgent(harness_url=...)`. The worker is thin and
 * stateless; this pod owns engine execution.
 *
 *   PORT=7700 ANTHROPIC_API_KEY=sk-ant-... \
 *     node --experimental-strip-types examples/harness-server.ts
 *
 * Pairs with: deploy/fullstack-base/harness-server.Dockerfile,
 *             deploy/fullstack-base/k8s/45-harness-server.yaml
 */
import { serve } from "@hono/node-server";
import { createHarnessServer } from "@computeragent/harness-server";
import { ClaudeAgentEngine } from "@computeragent/engine-claude-agent-sdk";
import { GitAgentProtocolLoader } from "@computeragent/identity-gitagentprotocol";
import { configure as configureOtel, OtelAuditSink, shutdown as shutdownOtel } from "@computeragent/observability";

// Optional OTel — same pattern as CAS so traces flow into NR via OTLP/HTTP.
let auditSink: ConstructorParameters<typeof createHarnessServer>[0]["auditSink"];
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const otlpHeaders = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);
  // Content capture OFF unless COMPUTERAGENT_CAPTURE_CONTENT is truthy; mode
  // defaults to "attributes" so content lands on span attributes (what the UI
  // and NRQL/ClickHouse read), not the logs pipeline.
  const captureContent = parseCaptureContent(process.env.COMPUTERAGENT_CAPTURE_CONTENT);
  configureOtel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? "harness-server",
    exporter: "otlp-http",
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    ...(otlpHeaders ? { headers: otlpHeaders } : {}),
    sampleRate: Number(process.env.OTEL_SAMPLE_RATE ?? 1.0),
    captureContent,
    ...(captureContent
      ? { captureContentMode: parseCaptureMode(process.env.COMPUTERAGENT_CAPTURE_CONTENT_MODE) }
      : {}),
  });
  auditSink = new OtelAuditSink();
  console.log(
    `[otel] OTLP/HTTP exporter → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}` +
      (otlpHeaders ? " (auth: headers set)" : "") +
      (captureContent
        ? ` (content capture: ${parseCaptureMode(process.env.COMPUTERAGENT_CAPTURE_CONTENT_MODE)})`
        : " (content capture: off)"),
  );
}

const app = createHarnessServer({
  engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  ...(auditSink ? { auditSink } : {}),
});

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 7700);
const server = serve({ fetch: app.fetch, port, hostname: host });
console.log(`harness-server listening on http://${host}:${port}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`[harness-server] ${sig} — shutting down`);
    await shutdownOtel(2_000).catch(() => {});
    server.close();
    process.exit(0);
  });
}

// OTel SDK spec: OTEL_EXPORTER_OTLP_HEADERS is comma-separated `key=value` pairs.
function parseOtlpHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// COMPUTERAGENT_CAPTURE_CONTENT=1 (or true/yes/on) → capture prompts/responses/tool IO.
function parseCaptureContent(raw: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((raw ?? "").trim());
}

// COMPUTERAGENT_CAPTURE_CONTENT_MODE ∈ attributes|events|both (default attributes).
function parseCaptureMode(raw: string | undefined): "attributes" | "events" | "both" {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "events" || v === "both" || v === "attributes" ? v : "attributes";
}
