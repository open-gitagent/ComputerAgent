// Eval runner — executes a suite case-by-case against the harness, captures the
// outcome (final output, tool calls, policy denials, cost, latency), scores it
// with the enabled scorers, and persists results into `eval_runs` incrementally
// so the UI can poll progress. Runs fire-and-forget in the background.

import { randomUUID } from "node:crypto";

import { caAuthHeader } from "./auth.js";
import { caBase } from "./upstream.js";
import { resolveAgent, runBodyFor, srsPolicyForAgent } from "./agent-defs.js";
import { evalRunsColl } from "./mongo.js";
import { scoreGolden, scoreJudge, scoreNfr, scoreToolCompliance } from "./eval-scorers.js";
import type {
  CaseResult,
  EvalCase,
  EvalRunDoc,
  EvalSuiteDoc,
  JudgeDef,
  PolicyDenial,
  ScoreResult,
  TranscriptEntry,
} from "./eval-types.js";

/** The judges that run for a suite — its `judges` list, or a single default
 *  judge migrated from the legacy single-judge fields. */
function resolveJudges(suite: EvalSuiteDoc): JudgeDef[] {
  if (suite.judges && suite.judges.length) return suite.judges;
  return [
    {
      id: "default",
      name: "Task success",
      ...(suite.judgePrompt ? { rubric: suite.judgePrompt } : {}),
      ...(suite.judgeModel ? { model: suite.judgeModel } : {}),
      ...(suite.judgePassThreshold !== undefined ? { passThreshold: suite.judgePassThreshold } : {}),
    },
  ];
}

/** Create the run doc and kick off execution in the background. Returns the run id. */
export async function startRun(suite: EvalSuiteDoc): Promise<string> {
  const runId = randomUUID();
  const run: EvalRunDoc = {
    _id: runId,
    suiteId: suite._id,
    suiteName: suite.name,
    agentName: suite.agentName,
    status: "running",
    startedAt: new Date(),
    results: [],
    summary: { total: suite.cases.length, passed: 0, passRate: 0 },
  };
  await (await evalRunsColl()).insertOne(run);
  // Fire-and-forget — the request returns the runId immediately; the UI polls.
  void executeRun(runId, suite).catch(async (err) => {
    try {
      await (await evalRunsColl()).updateOne(
        { _id: runId },
        { $set: { status: "failed", error: (err as Error).message, completedAt: new Date() } },
      );
    } catch {
      /* best-effort */
    }
  });
  return runId;
}

async function executeRun(runId: string, suite: EvalSuiteDoc): Promise<void> {
  const agent = await resolveAgent(suite.agentName);
  const coll = await evalRunsColl();
  if (!agent) {
    await coll.updateOne(
      { _id: runId },
      { $set: { status: "failed", error: `unknown agent: ${suite.agentName}`, completedAt: new Date() } },
    );
    return;
  }

  let passed = 0;
  const results: CaseResult[] = [];
  for (const c of suite.cases) {
    const result = await runCase(agent, c, suite);
    if (result.passed) passed += 1;
    results.push(result);
    // Persist after each case so the UI shows live progress.
    await coll.updateOne(
      { _id: runId },
      {
        $set: {
          results,
          summary: { total: suite.cases.length, passed, passRate: passed / suite.cases.length },
        },
      },
    );
  }

  const passRate = suite.cases.length ? passed / suite.cases.length : 0;
  await coll.updateOne(
    { _id: runId },
    {
      $set: {
        status: "completed",
        completedAt: new Date(),
        summary: {
          total: suite.cases.length,
          passed,
          passRate,
          gatePassed: suite.passThreshold === undefined ? undefined : passRate >= suite.passThreshold,
        },
      },
    },
  );
}

/** Run one case end-to-end and score it. */
async function runCase(
  agent: NonNullable<Awaited<ReturnType<typeof resolveAgent>>>,
  c: EvalCase,
  suite: EvalSuiteDoc,
): Promise<CaseResult> {
  const startedAt = Date.now();
  let outcome: Captured;
  try {
    outcome = await runAgainstHarness(agent, c.prompt);
  } catch (err) {
    return {
      caseId: c.id,
      prompt: c.prompt,
      output: "",
      toolCalls: [],
      policyDenials: [],
      transcript: [],
      costUsd: 0,
      latencyMs: Date.now() - startedAt,
      scores: [],
      passed: false,
      error: (err as Error).message,
    };
  }
  const latencyMs = Date.now() - startedAt;

  // Run enabled scorers.
  const scores: ScoreResult[] = [];
  if (suite.scorers.golden) scores.push(scoreGolden(c, outcome.output));
  if (suite.scorers.toolCompliance) scores.push(scoreToolCompliance(c, outcome));
  if (suite.scorers.nfr) scores.push(scoreNfr(c, { costUsd: outcome.costUsd, latencyMs }));
  if (suite.scorers.taskSuccess) {
    for (const judge of resolveJudges(suite)) {
      scores.push(await scoreJudge(c, outcome.output, outcome.transcript, judge));
    }
  }

  // A case passes only when every enabled scorer passes (vacuously true if none).
  const passed = scores.every((s) => s.passed);

  return {
    caseId: c.id,
    prompt: c.prompt,
    output: outcome.output,
    toolCalls: outcome.toolCalls,
    policyDenials: outcome.policyDenials,
    transcript: outcome.transcript,
    costUsd: outcome.costUsd,
    latencyMs,
    scores,
    passed,
  };
}

export interface Captured {
  output: string;
  toolCalls: string[];
  policyDenials: PolicyDenial[];
  transcript: TranscriptEntry[];
  systemTools: string[]; // tools the agent was configured with (from the run's system init)
  costUsd: number;
}

/**
 * POST the prompt to the harness /run endpoint (one-shot), attach the agent's
 * bound policy so policy denials are enforced + captured, and consume the SSE
 * stream server-side to extract the outcome.
 */
export async function runAgainstHarness(
  agent: NonNullable<Awaited<ReturnType<typeof resolveAgent>>>,
  prompt: string,
): Promise<Captured> {
  const body = runBodyFor(agent, prompt) as Record<string, unknown>;
  const policy = await srsPolicyForAgent(agent.name);
  if (policy) body.policy = policy;

  const r = await fetch(`${caBase()}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    const t = await r.text().catch(() => "");
    throw new Error(`harness /run ${r.status}: ${t.slice(0, 160)}`);
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  let output = "";
  const toolResultById = new Map<string, string>(); // tool_use_id -> result text (for deny reasons)
  let permissionDenials: Array<{ tool_name?: string; tool_use_id?: string }> = [];
  let systemTools: string[] = [];
  let costUsd = 0;
  // Build the trace, deduping partial assistant frames by message id (the SDK
  // emits a message repeatedly as its blocks complete — keep the latest).
  const tMessages = new Map<string, TranscriptEntry[]>();
  const tOrder: string[] = [];

  const handleFrame = (frame: string) => {
    let evName = "";
    let data: any = null;
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) evName = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        try {
          data = JSON.parse(line.slice(5).trim());
        } catch {
          /* skip non-JSON */
        }
      }
    }
    if (!data) return;
    const kind = evName || data.kind || "";

    if (kind === "ca_usage_snapshot" || data.kind === "ca_usage_snapshot") {
      if (typeof data.costUsd === "number") costUsd = data.costUsd;
      return;
    }
    if (kind !== "sdk_message" && data.kind !== "sdk_message") return;

    const payload = data.payload ?? {};
    const type = payload.type;
    if (type === "system" && payload.subtype === "init") {
      if (Array.isArray(payload.tools)) systemTools = payload.tools.map(String);
      return;
    }
    if (type === "assistant" && payload.message?.content) {
      const id = typeof payload.message.id === "string" ? payload.message.id : `a-${tOrder.length}`;
      if (!tMessages.has(id)) tOrder.push(id);
      const entries: TranscriptEntry[] = [];
      for (const block of payload.message.content) {
        if (block?.type === "thinking" && block.thinking) entries.push({ type: "thinking", text: String(block.thinking) });
        else if (block?.type === "text" && typeof block.text === "string") entries.push({ type: "text", text: block.text });
        else if (block?.type === "tool_use" && typeof block.name === "string") entries.push({ type: "tool_use", tool: block.name, input: block.input });
      }
      tMessages.set(id, entries);
    } else if (type === "user" && payload.message?.content) {
      for (const block of payload.message.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          const content = typeof block.content === "string"
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((x: any) => x?.text ?? "").join("")
              : "";
          toolResultById.set(block.tool_use_id, content);
          const key = `tr-${block.tool_use_id}`;
          if (!tMessages.has(key)) tOrder.push(key);
          tMessages.set(key, [{ type: "tool_result", text: content, isError: block.is_error === true }]);
        }
      }
    } else if (type === "result") {
      if (typeof payload.result === "string") output = payload.result;
      if (typeof payload.total_cost_usd === "number") costUsd = payload.total_cost_usd;
      if (Array.isArray(payload.permission_denials)) permissionDenials = payload.permission_denials;
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      handleFrame(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleFrame(buf);

  const transcript = tOrder.flatMap((id) => tMessages.get(id) ?? []);
  const toolCalls = transcript.filter((e) => e.type === "tool_use" && e.tool).map((e) => e.tool as string);
  const lastText = [...transcript].reverse().find((e) => e.type === "text")?.text ?? "";

  const policyDenials: PolicyDenial[] = permissionDenials.map((d) => ({
    tool: d.tool_name ?? "unknown",
    reason: (d.tool_use_id && toolResultById.get(d.tool_use_id)) || "blocked by policy",
  }));

  return {
    output: output || lastText,
    toolCalls,
    policyDenials,
    transcript,
    systemTools,
    costUsd,
  };
}
