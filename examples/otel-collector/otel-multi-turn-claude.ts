/**
 * OpenTelemetry observability — multi-turn, multi-tool agent demo. Designed to
 * showcase the full shape of a `gen_ai.*` trace tree:
 *
 *   - Three separate `invoke_agent` traces (one per user turn), all tied
 *     together by `gen_ai.conversation.id = sessionId`. Conversation is
 *     correlation, not parent/child — per the OTel GenAI spec.
 *   - Each turn runs the Anthropic agent loop several times, so each
 *     `invoke_agent` has 2–5 `chat` children + an `execute_tool` per
 *     tool call (Write / Read / Bash). Final `chat` per turn carries the
 *     assistant's wrap-up text.
 *   - Token usage, cost, and operation duration histograms accumulate across
 *     turns with consistent `gen_ai.conversation.id` so any aggregator
 *     (Grafana, ClickHouse, Langfuse) can roll up per-conversation cost.
 *
 *   # standalone (console exporter — no collector needed)
 *   ANTHROPIC_API_KEY=sk-ant-... \
 *     bun run examples/otel-collector/otel-multi-turn-claude.ts
 *
 *   # against the bundled OTLP collector (recommended — full debug + ClickHouse)
 *   docker compose -f examples/otel-collector/docker-compose.yml up -d
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
 *     ANTHROPIC_API_KEY=sk-ant-... \
 *     bun run examples/otel-collector/otel-multi-turn-claude.ts
 *
 * Trace tree (one per turn, same conversation.id):
 *
 *   Turn 1 — "create three notes"
 *     invoke_agent otel-notes-bot   [gen_ai.conversation.id = sess-xyz]
 *     ├── chat <model>              ← decides to write note1
 *     │   └── execute_tool Write    ← note1.md
 *     ├── chat <model>              ← decides to write note2
 *     │   └── execute_tool Write    ← note2.md
 *     ├── chat <model>              ← decides to write note3
 *     │   └── execute_tool Write    ← note3.md
 *     └── chat <model>              ← final assistant text "done"
 *
 *   Turn 2 — "read all three and summarise"
 *     invoke_agent otel-notes-bot   [gen_ai.conversation.id = sess-xyz]
 *     ├── chat → execute_tool Read (×3)
 *     ├── chat → execute_tool Write (summary.md)
 *     └── chat (final text)
 *
 *   Turn 3 — "ls + count"
 *     invoke_agent otel-notes-bot   [gen_ai.conversation.id = sess-xyz]
 *     ├── chat → execute_tool Bash  ← ls *.md
 *     └── chat (final answer)
 *
 * Unlike `otel-localhost-claude.ts` (single-turn, single-tool), this example
 * uses the long-lived session flow:
 *   1. POST /v1/sessions { streamingInput: true } — open session, send turn 1.
 *   2. GET  /v1/sessions/:id/events                — SSE; wait for `ca_usage_snapshot`.
 *   3. POST /v1/sessions/:id/messages              — send turn 2.
 *   4. wait for `ca_usage_snapshot` again.
 *   5. POST /v1/sessions/:id/messages              — send turn 3.
 *   6. POST /v1/sessions/:id/end-input             — close the queue, engine ends cleanly.
 *   7. DELETE /v1/sessions/:id                     — release the workdir.
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

const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
configure({
  serviceName: "computeragent-otel-multi-turn",
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

const app = createHarnessServer({
  engines: { "claude-agent-sdk": new ClaudeAgentEngine() },
  identityLoaders: { gitagentprotocol: new GitAgentProtocolLoader() },
  auditSink: new OtelAuditSink(),
});

const port = 7900 + Math.floor(Math.random() * 100);
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
const base = `http://127.0.0.1:${port}`;
console.log(`harness-server listening on ${base}\n`);

// The three turns. Each is intentionally tool-heavy so the per-turn
// invoke_agent span has multiple chat→execute_tool children.
const TURNS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "turn 1 — create three notes",
    text:
      'Create three separate markdown files in the current directory: ' +
      '`note1.md` containing one sentence about TypeScript, ' +
      '`note2.md` containing one sentence about OpenTelemetry, and ' +
      '`note3.md` containing one sentence about observability. ' +
      "Use the Write tool — one call per file. Reply 'done' when finished.",
  },
  {
    label: "turn 2 — read all + write summary.md",
    text:
      'Read note1.md, note2.md, and note3.md, then write a new file ' +
      '`summary.md` that begins with the heading "# Summary" and contains ' +
      'one paragraph combining the three sentences. Reply with the contents ' +
      'of summary.md when done.',
  },
  {
    label: "turn 3 — bash listing",
    text:
      'Use the Bash tool to run `ls -1 *.md | sort` in the current directory ' +
      'and tell me how many .md files exist and their names. Do not write or ' +
      'edit anything in this turn.',
  },
];

const AGENT_FILES: Record<string, string> = {
  "agent.yaml": [
    'spec_version: "0.1.0"',
    "name: otel-notes-bot",
    "version: 0.1.0",
    "model:",
    "  preferred: claude-haiku-4-5-20251001",
    "runtime:",
    "  max_turns: 25",
  ].join("\n"),
  "SOUL.md":
    "You are a terse file-system assistant. Use only the Write, Read, Edit, " +
    "and Bash tools. Do exactly what the user asks — no more, no less. " +
    "Never invent files. When asked to create N files, make exactly N tool " +
    "calls — one per file — back to back.",
};

interface CreateSessionResp {
  readonly sessionId: string;
  readonly eventsUrl: string;
}

interface SseFrame {
  readonly kind: string;
  readonly data: Record<string, unknown>;
}

function parseSseFrame(frame: string): SseFrame | undefined {
  const evMatch = frame.match(/^event: (.+)$/m);
  const dataMatch = frame.match(/^data: (.+)$/m);
  if (!evMatch || !dataMatch) return undefined;
  return { kind: evMatch[1] ?? "", data: JSON.parse(dataMatch[1] ?? "{}") };
}

let totalIn = 0;
let totalOut = 0;
let totalCost = 0;
let sessionId = "";

try {
  // 1. Open a long-lived session with the first turn pre-queued. The harness
  //    will accept follow-up messages because `streamingInput: true` keeps
  //    the user-message queue open until we call /end-input.
  const createRes = await fetch(`${base}/v1/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      engine: "claude-agent-sdk",
      identity: {
        loader: "gitagentprotocol",
        source: { type: "inline" as const, manifest: { name: "otel-notes-bot", version: "0.1.0" }, files: AGENT_FILES },
      },
      envs: { ANTHROPIC_API_KEY },
      messages: [{ role: "user" as const, content: TURNS[0]!.text }],
      options: { permissionMode: "bypassPermissions" },
      streamingInput: true,
    }),
  });
  if (!createRes.ok) {
    throw new Error(`POST /v1/sessions failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { sessionId: sid, eventsUrl } = (await createRes.json()) as CreateSessionResp;
  sessionId = sid;
  console.log(`session: ${sessionId}\n`);
  console.log(`-> ${TURNS[0]!.label}`);

  // 2. Open the SSE stream. The engine drive kicks off on the first GET.
  const sseRes = await fetch(`${base}${eventsUrl}`, {
    headers: { Accept: "text/event-stream" },
  });
  if (!sseRes.ok || !sseRes.body) {
    throw new Error(`GET ${eventsUrl} failed: ${sseRes.status} ${await sseRes.text()}`);
  }

  let pendingTurn = 1; // index of the NEXT turn to send (0-based)
  const reader = sseRes.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";

  // The state machine: stream events; when a `ca_usage_snapshot` arrives
  // we know the current turn finished. Send the next turn (if any), else
  // close the input queue and wait for `ca_session_ended`.
  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseSseFrame(frame);
      if (!parsed) continue;
      const { kind, data } = parsed;

      if (kind === "ca_turn_started") {
        // Engine accepted the message and opened a new invoke_agent span.
        // turnIndex is 0-based; +1 makes the printout match the labels above.
        const turnIdx = (data.turnIndex as number) ?? 0;
        if (turnIdx > 0) {
          // For follow-up turns we already printed the label below before
          // POSTing, so just acknowledge the boundary.
          console.log(`  (turn ${turnIdx} started server-side)`);
        }
      } else if (kind === "sdk_message" && (data.payload as { type?: string })?.type === "assistant") {
        // Print any plain-text content blocks the assistant emits for
        // visual feedback. Tool_use blocks are skipped here — they show up
        // as their own execute_tool span in the trace.
        const payload = data.payload as {
          message?: { content?: ReadonlyArray<{ type?: string; text?: string; name?: string }> };
        };
        for (const block of payload.message?.content ?? []) {
          if (block.type === "text" && block.text) {
            const trimmed = block.text.trim();
            if (trimmed) console.log(`  assistant: ${trimmed.slice(0, 140)}`);
          } else if (block.type === "tool_use" && block.name) {
            console.log(`  → ${block.name}`);
          }
        }
      } else if (kind === "ca_usage_snapshot") {
        // Per-turn usage snapshot from claude-agent-sdk. costSemantic is
        // "cumulative" for this engine — each snapshot is the running total
        // for the session — so we display the delta from last snapshot for
        // a per-turn read while keeping the rolling sum from the snapshot
        // value itself.
        const inT = (data.inputTokens as number | undefined) ?? 0;
        const outT = (data.outputTokens as number | undefined) ?? 0;
        const c = (data.costUsd as number | undefined) ?? 0;
        const dIn = inT - totalIn;
        const dOut = outT - totalOut;
        const dCost = c - totalCost;
        totalIn = inT;
        totalOut = outT;
        totalCost = c;
        console.log(
          `  ✓ turn done: +${dIn} in / +${dOut} out tokens, +$${dCost.toFixed(4)} ` +
            `(running: ${inT}/${outT} tok, $${c.toFixed(4)})`,
        );

        // Fire the next turn, or end input if we've sent them all.
        if (pendingTurn < TURNS.length) {
          const t = TURNS[pendingTurn]!;
          console.log(`\n-> ${t.label}`);
          const r = await fetch(`${base}/v1/sessions/${sessionId}/messages`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: { role: "user", content: t.text } }),
          });
          if (!r.ok) throw new Error(`POST messages failed: ${r.status} ${await r.text()}`);
          pendingTurn += 1;
        } else {
          // No more turns — close the queue so the engine returns cleanly.
          await fetch(`${base}/v1/sessions/${sessionId}/end-input`, { method: "POST" });
        }
      } else if (kind === "ca_session_ended") {
        console.log(`\nsession ended: ${data.reason}`);
        break outer;
      }
    }
  }

  console.log(
    `\ntotal across 3 turns: ${totalIn} in / ${totalOut} out tokens • $${totalCost.toFixed(4)}`,
  );
  console.log("\nWhat to look at in the trace UI / console exporter:");
  console.log("  • 3 root invoke_agent spans, same gen_ai.conversation.id");
  console.log("  • each invoke_agent has multiple chat + execute_tool children");
  console.log("  • gen_ai.input.messages / output.messages cover the full conversation");
  console.log("  • gen_ai.client.token.usage histogram aggregates across all chats");
  console.log("  • computeragent.usage.cost_usd records cumulative cost per chat");
} finally {
  // Cleanup: flush OTel exporters first (so the LAST batch of spans lands),
  // then drop the session, then close the HTTP server.
  await shutdown(2_000);
  if (sessionId) {
    await fetch(`${base}/v1/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
  }
  server.close();
}
