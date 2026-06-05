// Shared types for the Evals feature — suites (the test definitions) and runs
// (the scored results). Stored as whole documents in `eval_suites` / `eval_runs`.

/** A golden-output expectation for the golden-match scorer. */
export interface GoldenExpectation {
  mode: "exact" | "contains" | "regex";
  value: string;
}

/** One test case in a suite. */
export interface EvalCase {
  id: string;
  /** The prompt/task sent to the agent. */
  prompt: string;
  /** Free-text success criteria for the LLM-judge scorer. */
  criteria?: string;
  /** Expected final-output match for the golden scorer. */
  golden?: GoldenExpectation;
  /** Tool-compliance: tools the agent SHOULD use. */
  expectedTools?: string[];
  /** Tool-compliance: tools the agent must NOT use (a policy-denied tool counts as compliant). */
  forbiddenTools?: string[];
  /** NFR: max cost in USD for the case. */
  maxCostUsd?: number;
  /** NFR: max wall-clock latency in ms for the case. */
  maxLatencyMs?: number;
}

/**
 * One LLM-as-a-judge (OpenAI score_model style). A suite can have several; each
 * scores every case independently against its own rubric and is shown
 * separately in the results. Returns a 0..1 score; pass = score >= passThreshold.
 */
export interface JudgeDef {
  id: string;
  name: string; // display name, e.g. "Correctness", "Safety"
  /** Custom rubric template (vars: {{prompt}} {{criteria}} {{output}} {{trace}} {{tools}} {{golden}}). Empty -> default. */
  rubric?: string;
  model?: string;
  passThreshold?: number; // 0..1, default 0.5
}

/** Which scorers are enabled for the suite. */
export interface ScorerConfig {
  taskSuccess: boolean; // LLM-judge against `criteria`
  toolCompliance: boolean; // expected/forbidden tools + policy denials
  golden: boolean; // exact/contains/regex on final output
  nfr: boolean; // cost / latency thresholds
}

export interface EvalSuiteDoc {
  _id: string; // suite id
  name: string;
  description?: string;
  agentName: string; // which registered agent the suite runs against
  cases: EvalCase[];
  scorers: ScorerConfig;
  /** LLM judges run when scorers.taskSuccess is on. Empty -> one default judge. */
  judges?: JudgeDef[];
  // Legacy single-judge fields (pre-multi-judge) — migrated into `judges` on read.
  judgeModel?: string;
  judgePrompt?: string;
  judgePassThreshold?: number;
  /** Regression gate: a run is "passing" only if passRate >= this (0..1). */
  passThreshold?: number;
  createdAt: Date;
  updatedAt: Date;
}

/** One scorer's verdict on a case. */
export interface ScoreResult {
  scorer: "taskSuccess" | "toolCompliance" | "golden" | "nfr";
  /** For judges (scorer="taskSuccess"): the judge's display name. */
  label?: string;
  passed: boolean;
  /** Optional 0..1 score (e.g. LLM-judge confidence). */
  score?: number;
  detail?: string;
}

/** A policy denial captured during a case run (from policy_decision events). */
export interface PolicyDenial {
  tool: string;
  reason: string;
}

/** One step of the agent's trace for a case (the full run transcript). */
export interface TranscriptEntry {
  type: "thinking" | "text" | "tool_use" | "tool_result";
  text?: string; // for thinking / text / tool_result content
  tool?: string; // for tool_use
  input?: unknown; // for tool_use
  isError?: boolean; // for tool_result
}

/** The scored result of running one case. */
export interface CaseResult {
  caseId: string;
  prompt: string;
  output: string;
  toolCalls: string[]; // tool names invoked (in order)
  policyDenials: PolicyDenial[];
  transcript: TranscriptEntry[]; // full agent trace (thinking / text / tool calls / results)
  costUsd: number;
  latencyMs: number;
  scores: ScoreResult[];
  passed: boolean; // all enabled scorers passed
  error?: string; // set when the run itself failed
}

export interface EvalRunSummary {
  total: number;
  passed: number;
  passRate: number; // 0..1
  gatePassed?: boolean; // passRate >= suite.passThreshold
}

export interface EvalRunDoc {
  _id: string; // run id
  suiteId: string;
  suiteName: string;
  agentName: string;
  status: "running" | "completed" | "failed";
  startedAt: Date;
  completedAt?: Date;
  results: CaseResult[];
  summary: EvalRunSummary;
  error?: string;
}
