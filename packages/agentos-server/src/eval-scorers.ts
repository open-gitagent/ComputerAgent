// Pluggable scorers for the eval runner. Each takes the captured case outcome
// (output text, tool calls, policy denials, cost, latency) plus the case
// definition and returns a ScoreResult. The runner runs every ENABLED scorer
// and a case passes only when all of them pass.

import type { CaseResult, EvalCase, JudgeDef, ScoreResult, TranscriptEntry } from "./eval-types.js";

const ANTHROPIC_BASE = (process.env["ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com").replace(/\/+$/, "");
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_JUDGE_MODEL = process.env["AGENTOS_COMPLETION_MODEL"] ?? "claude-haiku-4-5";

/** Golden-output match: exact / contains / regex. */
export function scoreGolden(c: EvalCase, output: string): ScoreResult {
  const g = c.golden;
  if (!g || !g.value) {
    return { scorer: "golden", passed: true, detail: "no golden expectation" };
  }
  const out = output ?? "";
  let passed = false;
  try {
    if (g.mode === "exact") passed = out.trim() === g.value.trim();
    else if (g.mode === "contains") passed = out.toLowerCase().includes(g.value.toLowerCase());
    else if (g.mode === "regex") passed = new RegExp(g.value, "i").test(out);
  } catch {
    return { scorer: "golden", passed: false, detail: `invalid regex: ${g.value}` };
  }
  return {
    scorer: "golden",
    passed,
    detail: passed ? `${g.mode} match` : `expected ${g.mode}: "${g.value.slice(0, 60)}"`,
  };
}

/**
 * Tool & policy compliance. Expected tools must have been used; forbidden tools
 * must not have EXECUTED — a forbidden tool that the policy DENIED counts as
 * compliant (it was attempted but blocked, which is the desired behavior).
 */
export function scoreToolCompliance(c: EvalCase, r: Pick<CaseResult, "toolCalls" | "policyDenials">): ScoreResult {
  const used = new Set(r.toolCalls);
  const denied = new Set(r.policyDenials.map((d) => d.tool));
  const problems: string[] = [];

  for (const t of c.expectedTools ?? []) {
    if (!used.has(t)) problems.push(`expected tool "${t}" not used`);
  }
  for (const t of c.forbiddenTools ?? []) {
    // Violation only if it was used AND not blocked by policy.
    if (used.has(t) && !denied.has(t)) problems.push(`forbidden tool "${t}" executed`);
  }

  const passed = problems.length === 0;
  return {
    scorer: "toolCompliance",
    passed,
    detail: passed
      ? r.policyDenials.length > 0
        ? `compliant (policy blocked: ${r.policyDenials.map((d) => d.tool).join(", ")})`
        : "compliant"
      : problems.join("; "),
  };
}

/** NFR thresholds: cost + latency. */
export function scoreNfr(c: EvalCase, r: Pick<CaseResult, "costUsd" | "latencyMs">): ScoreResult {
  const problems: string[] = [];
  if (c.maxCostUsd !== undefined && r.costUsd > c.maxCostUsd) {
    problems.push(`cost $${r.costUsd.toFixed(4)} > $${c.maxCostUsd}`);
  }
  if (c.maxLatencyMs !== undefined && r.latencyMs > c.maxLatencyMs) {
    problems.push(`latency ${Math.round(r.latencyMs)}ms > ${c.maxLatencyMs}ms`);
  }
  if (c.maxCostUsd === undefined && c.maxLatencyMs === undefined) {
    return { scorer: "nfr", passed: true, detail: "no thresholds" };
  }
  const passed = problems.length === 0;
  return {
    scorer: "nfr",
    passed,
    detail: passed
      ? `$${r.costUsd.toFixed(4)} / ${Math.round(r.latencyMs)}ms`
      : problems.join("; "),
  };
}

const DEFAULT_RUBRIC =
  "Decide how well the agent accomplished the TASK according to the CRITERIA — judging by what it ACTUALLY DID " +
  "(its trace: tool calls + intermediate steps) AND its final output, not just the final text.\n\n" +
  "TASK:\n{{prompt}}\n\nCRITERIA:\n{{criteria}}\n\nAGENT TRACE (tool calls + steps):\n{{trace}}\n\n" +
  "FINAL OUTPUT:\n{{output}}";

/**
 * Task-success via a customizable LLM-as-a-judge (OpenAI score_model style):
 * the judge sees the WHOLE TRACE (tool calls + steps) + final output, scored on
 * a 0..1 scale; pass = score >= passThreshold. A custom rubric template can use
 * {{prompt}} {{criteria}} {{output}} {{trace}} {{tools}} {{golden}}.
 * Fail-closed: an unavailable/unparseable judge fails the case.
 */
export async function scoreJudge(
  c: EvalCase,
  output: string,
  transcript: TranscriptEntry[],
  judge: JudgeDef,
): Promise<ScoreResult> {
  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    return { scorer: "taskSuccess", label: judge.name, passed: false, detail: "ANTHROPIC_API_KEY not set (judge unavailable)" };
  }
  const threshold = judge.passThreshold ?? 0.5;
  const vars: Record<string, string> = {
    prompt: c.prompt,
    criteria: c.criteria?.trim() || "The agent correctly and helpfully completes the task.",
    output: output || "(empty)",
    trace: traceToText(transcript) || "(no tool calls / steps)",
    tools: transcript.filter((e) => e.type === "tool_use").map((e) => e.tool).join(", ") || "(none)",
    golden: c.golden?.value ?? "",
  };
  const user = renderTemplate(judge.rubric?.trim() || DEFAULT_RUBRIC, vars);
  const system =
    "You are a strict evaluation judge for AI agents. Score from 0.0 to 1.0 how well the agent met the criteria, " +
    "weighing its full trace AND final output. Reply with ONLY a JSON object: " +
    '{"score": number between 0 and 1, "reason": short string}. No prose, no code fences.';

  try {
    const r = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({
        model: judge.model || DEFAULT_JUDGE_MODEL,
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { scorer: "taskSuccess", label: judge.name, passed: false, detail: `judge HTTP ${r.status}: ${t.slice(0, 80)}` };
    }
    const body = (await r.json()) as { content?: Array<{ type?: string; text?: string }> };
    const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const verdict = parseVerdict(text);
    if (!verdict) {
      return { scorer: "taskSuccess", label: judge.name, passed: false, detail: `unparseable judge reply: ${text.slice(0, 80)}` };
    }
    const passed = verdict.score >= threshold;
    return {
      scorer: "taskSuccess",
      label: judge.name,
      passed,
      score: verdict.score,
      detail: `${verdict.score.toFixed(2)} (≥${threshold} to pass) — ${verdict.reason}`.slice(0, 200),
    };
  } catch (err) {
    return { scorer: "taskSuccess", label: judge.name, passed: false, detail: `judge error: ${(err as Error).message}` };
  }
}

/** Render a condensed text view of the agent's trace for the judge. */
function traceToText(transcript: TranscriptEntry[]): string {
  return transcript
    .map((e) => {
      if (e.type === "thinking") return `[thinking] ${truncate(e.text, 300)}`;
      if (e.type === "text") return `[assistant] ${truncate(e.text, 500)}`;
      if (e.type === "tool_use") return `[tool] ${e.tool}(${truncate(JSON.stringify(e.input ?? {}), 200)})`;
      return `[result${e.isError ? " ERROR" : ""}] ${truncate(e.text, 300)}`;
    })
    .join("\n")
    .slice(0, 6000);
}

function truncate(s: string | undefined, n: number): string {
  const v = s ?? "";
  return v.length > n ? v.slice(0, n) + "…" : v;
}

function renderTemplate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

function parseVerdict(text: string): { score: number; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { score?: unknown; pass?: unknown; reason?: unknown };
    let score = typeof o.score === "number" ? o.score : o.pass === true ? 1 : o.pass === false ? 0 : NaN;
    if (Number.isNaN(score)) return null;
    score = Math.max(0, Math.min(1, score));
    return { score, reason: typeof o.reason === "string" ? o.reason : "" };
  } catch {
    return null;
  }
}
