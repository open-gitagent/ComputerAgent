/**
 * KnowledgeDistiller — turns Lyra's Slack conversations into durable, generic
 * COMPANY knowledge and proposes it back to Lyra's own GAP repo as a pull
 * request (human-reviewed before merge). No user-specific / personal / PII data
 * is ever learned.
 *
 * Why this lives in the harness (not the agent): every exchange is already
 * persisted to Mongo `agent_logs` by the Slack bot, and this process already
 * holds the Anthropic key + Lyra's GitHub token. A deterministic daily pass over
 * those logs captures *every* session, centralizes the PII filtering, and
 * doesn't depend on the (flaky) agent loop. The PR is the review backstop.
 *
 * Pipeline (runOnce):
 *   agent_logs since watermark
 *     → group by thread (sessionId)
 *     → Anthropic distill (company facts only, forced-tool JSON output)
 *     → deterministic PII scrub
 *     → dedup vs the knowledge_index
 *     → append to knowledge/company/knowledge.md on a daily branch
 *     → open (or reuse) one PR/day to the repo
 *     → advance the watermark
 *
 * Env (see slack-bot.ts wiring): LYRA_LEARN=1, LYRA_LEARN_HOUR (UTC, default 2),
 * LYRA_LEARN_REPO (default = lyra bot source), LYRA_LEARN_MODEL
 * (default claude-sonnet-4-6). Reuses GITAGENT_ANTHROPIC_API_KEY + the lyra
 * bot's gitToken.
 */
import { createHash } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import { AgentLogStore, type AgentLogEntry } from "./agent-log-store.ts";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_KNOWLEDGE_PATH = "knowledge/company/knowledge.md";
const MAX_TRANSCRIPT_CHARS = 120_000; // cap the distill request size
const MIN_STATEMENT_CHARS = 20;

export interface DistillerConfig {
  readonly mongoUrl: string;
  readonly mongoDb: string;
  /** Bot name in agent_logs (e.g. "lyra"). */
  readonly bot: string;
  /** Target repo — bare `github.com/owner/name` or an https URL. */
  readonly repo: string;
  /** GitHub PAT with `repo` + PR scope on the target repo. */
  readonly gitToken: string;
  /** Anthropic API key (GITAGENT_ANTHROPIC_API_KEY). */
  readonly anthropicKey: string;
  readonly model?: string;
  /** Path in the repo the knowledge is appended to. */
  readonly knowledgePath?: string;
}

export interface DistillResult {
  scannedThreads: number;
  extracted: number;
  afterScrub: number;
  fresh: number;
  freshStatements: string[];
  prUrl: string | null;
  skippedReason?: string;
}

interface WatermarkDoc {
  _id: string; // `${bot}:knowledge`
  bot: string;
  lastRunTs: Date | null;
  hashes: string[];
}

// ── Repo parsing ───────────────────────────────────────────────────────────
export function parseRepo(repo: string): { owner: string; name: string } {
  // Accept github.com/owner/name, https://github.com/owner/name(.git), git@…
  const m = repo.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) throw new Error(`Cannot parse owner/name from repo: ${repo}`);
  return { owner: m[1], name: m[2] };
}

// ── PII scrub (deterministic backstop) ──────────────────────────────────────
const PII_PATTERNS: RegExp[] = [
  /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/, // email
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/, // API keys
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/, // slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /<@[UW][A-Z0-9]{6,}>/, // slack mention
  /\b[UW][A-Z0-9]{8,}\b/, // bare slack user id
  /\d[\d\s().+-]{6,}\d/, // phone-ish: a run of 8+ digits/separators
  // personal attribution: "Alice said/asked/wants/prefers/…"
  /\b[A-Z][a-z]+\s+(said|says|asked|asks|mentioned|wants|wanted|prefers|preferred|requested|reported|complained|noted|thinks|thought|told|emailed|messaged|dm'?d)\b/,
  /\bmy (name|email|phone|address|password|account)\b/i,
];

/** Returns the reason the statement is unsafe/unusable, or null if it passes. */
export function piiReject(statement: string): string | null {
  const s = statement.trim();
  if (s.length < MIN_STATEMENT_CHARS) return "too-short";
  for (const re of PII_PATTERNS) {
    if (re.test(s)) return `pii:${re.source.slice(0, 24)}`;
  }
  return null;
}

// ── Dedup ────────────────────────────────────────────────────────────────
export function normalizeHash(statement: string): string {
  const norm = statement
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(norm).digest("hex").slice(0, 32);
}

/** Split fresh vs. already-known statements against a set of seen hashes. */
export function dedupe(
  statements: string[],
  seen: Set<string>,
): { fresh: string[]; hashes: string[] } {
  const fresh: string[] = [];
  const hashes: string[] = [];
  const batch = new Set<string>();
  for (const s of statements) {
    const h = normalizeHash(s);
    if (seen.has(h) || batch.has(h)) continue;
    batch.add(h);
    fresh.push(s);
    hashes.push(h);
  }
  return { fresh, hashes };
}

// ── Transcript assembly ─────────────────────────────────────────────────────
function groupThreads(entries: AgentLogEntry[]): string[] {
  const byThread = new Map<string, AgentLogEntry[]>();
  for (const e of entries) {
    const key = e.sessionId ?? e.threadTs ?? e._id;
    (byThread.get(key) ?? byThread.set(key, []).get(key)!).push(e);
  }
  const blocks: string[] = [];
  for (const [, turns] of byThread) {
    const lines: string[] = [];
    for (const t of turns) {
      if (t.query) lines.push(`User: ${t.query}`);
      if (t.reply) lines.push(`Assistant: ${t.reply}`);
    }
    if (lines.length) blocks.push(lines.join("\n"));
  }
  return blocks;
}

const DISTILL_SYSTEM =
  "You extract durable, GENERIC COMPANY KNOWLEDGE from internal Slack conversations so a " +
  "company assistant can reuse it in future conversations.\n\n" +
  "INCLUDE only standalone facts about: the company, its products/services, projects and work " +
  "done, processes and how things work, decisions and their rationale, domain terminology, " +
  "team structure at a role level (not individuals), and tools/systems the company uses.\n\n" +
  "EXCLUDE absolutely anything user-specific or personal: individual people's names, who said or " +
  "asked what, personal opinions/preferences, contact details, credentials/tokens/keys, one-off " +
  "request details, greetings/chit-chat, and anything that identifies a person. If a fact can " +
  "only be stated by naming or referring to a specific person, DROP it.\n\n" +
  "Each statement must be self-contained, present-tense, and understandable without the " +
  "conversation. Prefer fewer, higher-quality facts. If nothing generalizable is present, return " +
  "an empty list.";

const DISTILL_TOOL = {
  name: "record_company_knowledge",
  description: "Record the generic, non-personal company knowledge facts extracted from the conversations.",
  input_schema: {
    type: "object",
    properties: {
      statements: {
        type: "array",
        items: { type: "string" },
        description: "Standalone generic company-knowledge facts. Empty if none.",
      },
    },
    required: ["statements"],
  },
} as const;

async function distill(
  transcripts: string[],
  cfg: DistillerConfig,
): Promise<string[]> {
  if (transcripts.length === 0) return [];
  let blob = transcripts.join("\n\n---\n\n");
  if (blob.length > MAX_TRANSCRIPT_CHARS) blob = blob.slice(0, MAX_TRANSCRIPT_CHARS);

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": cfg.anthropicKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model ?? DEFAULT_MODEL,
      max_tokens: 4096,
      system: DISTILL_SYSTEM,
      tools: [DISTILL_TOOL],
      tool_choice: { type: "tool", name: DISTILL_TOOL.name },
      messages: [
        {
          role: "user",
          content:
            "Extract generic company knowledge from the following Slack conversations. " +
            "Remember: no names, no who-said-what, no personal or user-specific data.\n\n" +
            blob,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic distill failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: { statements?: unknown } }>;
  };
  const toolBlock = data.content?.find(
    (b) => b.type === "tool_use" && b.name === DISTILL_TOOL.name,
  );
  const statements = toolBlock?.input?.statements;
  if (!Array.isArray(statements)) return [];
  return statements.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

// ── GitHub PR (Contents API) ─────────────────────────────────────────────────
function b64encode(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
function b64decode(s: string): string {
  return Buffer.from(s, "base64").toString("utf8");
}

class Github {
  private readonly owner: string;
  private readonly name: string;
  private readonly token: string;
  constructor(owner: string, name: string, token: string) {
    this.owner = owner;
    this.name = name;
    this.token = token;
  }

  private async api(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`https://api.github.com/repos/${this.owner}/${this.name}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "User-Agent": "computeragent-knowledge-distiller",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
  }

  async defaultBranch(): Promise<{ branch: string; sha: string }> {
    const r = await this.api("");
    if (!r.ok) throw new Error(`repo lookup ${r.status}`);
    const branch = ((await r.json()) as { default_branch: string }).default_branch;
    const ref = await this.api(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (!ref.ok) throw new Error(`ref lookup ${ref.status}`);
    const sha = ((await ref.json()) as { object: { sha: string } }).object.sha;
    return { branch, sha };
  }

  /** Create the branch off baseSha if it doesn't already exist. */
  async ensureBranch(branch: string, baseSha: string): Promise<void> {
    const existing = await this.api(`/git/ref/heads/${encodeURIComponent(branch)}`);
    if (existing.ok) return;
    const r = await this.api("/git/refs", {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
    });
    if (!r.ok && r.status !== 422) {
      throw new Error(`create branch ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
  }

  async getFile(path: string, ref: string): Promise<{ content: string; sha: string } | null> {
    const r = await this.api(`/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`get file ${r.status}`);
    const j = (await r.json()) as { content: string; sha: string; encoding: string };
    return { content: b64decode(j.content.replace(/\n/g, "")), sha: j.sha };
  }

  async putFile(path: string, content: string, branch: string, message: string, sha?: string): Promise<void> {
    const r = await this.api(`/contents/${path}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: b64encode(content), branch, ...(sha ? { sha } : {}) }),
    });
    if (!r.ok) throw new Error(`put file ${r.status} ${(await r.text()).slice(0, 200)}`);
  }

  /** Return the open PR URL for head branch, opening one if needed. */
  async ensurePr(branch: string, base: string, title: string, body: string): Promise<string> {
    const list = await this.api(`/pulls?state=open&head=${this.owner}:${encodeURIComponent(branch)}`);
    if (list.ok) {
      const prs = (await list.json()) as Array<{ html_url: string }>;
      if (prs.length > 0) return prs[0].html_url;
    }
    const r = await this.api("/pulls", {
      method: "POST",
      body: JSON.stringify({ title, head: branch, base, body }),
    });
    if (!r.ok) throw new Error(`open PR ${r.status} ${(await r.text()).slice(0, 200)}`);
    return ((await r.json()) as { html_url: string }).html_url;
  }
}

// ── The pipeline ────────────────────────────────────────────────────────────
export class KnowledgeDistiller {
  private readonly client: MongoClient;
  private readonly logStore: AgentLogStore;
  private readonly cfg: DistillerConfig;
  private connected = false;

  constructor(cfg: DistillerConfig) {
    this.cfg = cfg;
    this.client = new MongoClient(cfg.mongoUrl);
    this.logStore = new AgentLogStore(cfg.mongoUrl, cfg.mongoDb);
  }

  private async coll(): Promise<Collection<WatermarkDoc>> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
    }
    return this.client.db(this.cfg.mongoDb).collection<WatermarkDoc>("knowledge_index");
  }

  private wmId(): string {
    return `${this.cfg.bot}:knowledge`;
  }

  /**
   * Run one distillation pass. When `dryRun`, everything runs except the branch
   * write / PR / watermark advance — returns what *would* be written.
   */
  async runOnce(opts: { dryRun?: boolean } = {}): Promise<DistillResult> {
    const wm = await (await this.coll()).findOne({ _id: this.wmId() });
    const since = wm?.lastRunTs ?? new Date(0);
    const seen = new Set(wm?.hashes ?? []);

    const entries = await this.logStore.listSince(this.cfg.bot, since);
    const transcripts = groupThreads(entries);
    const result: DistillResult = {
      scannedThreads: transcripts.length,
      extracted: 0,
      afterScrub: 0,
      fresh: 0,
      freshStatements: [],
      prUrl: null,
    };
    if (transcripts.length === 0) {
      result.skippedReason = "no new conversations";
      return result;
    }

    const extracted = await distill(transcripts, this.cfg);
    result.extracted = extracted.length;
    const clean = extracted.filter((s) => piiReject(s) === null);
    result.afterScrub = clean.length;

    const { fresh, hashes } = dedupe(clean, seen);
    result.fresh = fresh.length;
    result.freshStatements = fresh;
    if (fresh.length === 0) {
      if (!opts.dryRun) await this.advanceWatermark(entries, []);
      result.skippedReason = "nothing new to learn";
      return result;
    }

    if (opts.dryRun) return result;

    result.prUrl = await this.openPr(fresh);
    await this.advanceWatermark(entries, hashes);
    return result;
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private async openPr(fresh: string[]): Promise<string> {
    const { owner, name } = parseRepo(this.cfg.repo);
    const gh = new Github(owner, name, this.cfg.gitToken);
    const path = this.cfg.knowledgePath ?? DEFAULT_KNOWLEDGE_PATH;
    const day = this.today();
    const branch = `knowledge/auto-${day}`;

    const base = await gh.defaultBranch();
    await gh.ensureBranch(branch, base.sha);

    const existing = await gh.getFile(path, branch);
    const header = existing
      ? existing.content.replace(/\s*$/, "")
      : "# Company knowledge\n\n" +
        "Generic, non-personal company knowledge accumulated from conversations.\n" +
        "Auto-proposed by the knowledge distiller; review each entry before merging.";
    const section =
      `\n\n## Learned ${day}\n\n` + fresh.map((s) => `- ${s.trim()}`).join("\n") + "\n";
    const newContent = header + section;

    await gh.putFile(
      path,
      newContent,
      branch,
      `chore(knowledge): distilled company knowledge (${day})`,
      existing?.sha,
    );

    const body =
      `Auto-distilled **generic company knowledge** from recent conversations.\n\n` +
      `**${fresh.length}** new fact(s) proposed for \`${path}\`.\n\n` +
      `> ⚠️ Review before merging: confirm each fact is accurate and that **no personal / ` +
      `user-specific data** slipped through. Only generic company knowledge belongs here.\n`;
    return gh.ensurePr(branch, base.branch, `Company knowledge — ${day}`, body);
  }

  private async advanceWatermark(entries: AgentLogEntry[], newHashes: string[]): Promise<void> {
    const latest = entries.reduce<Date>(
      (max, e) => (e.ts > max ? e.ts : max),
      new Date(0),
    );
    await (await this.coll()).updateOne(
      { _id: this.wmId() },
      {
        $set: { bot: this.cfg.bot, lastRunTs: latest },
        ...(newHashes.length ? { $push: { hashes: { $each: newHashes } } } : {}),
      },
      { upsert: true },
    );
  }

  /**
   * Run `runOnce` every 24h, first firing at the next `hourUtc`. Returns a stop
   * function. Errors are logged, never thrown (best-effort background job).
   */
  startScheduler(hourUtc = 2): () => void {
    const tick = async () => {
      try {
        const r = await this.runOnce();
        console.log(
          `[knowledge] ${this.cfg.bot}: threads=${r.scannedThreads} extracted=${r.extracted} ` +
            `fresh=${r.fresh} pr=${r.prUrl ?? r.skippedReason ?? "none"}`,
        );
      } catch (e) {
        console.error(`[knowledge] ${this.cfg.bot}: distill run failed:`, (e as Error).message);
      }
    };
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUtc, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const firstDelay = next.getTime() - now.getTime();

    let interval: ReturnType<typeof setInterval> | null = null;
    const first = setTimeout(() => {
      void tick();
      interval = setInterval(() => void tick(), 24 * 60 * 60 * 1000);
    }, firstDelay);
    console.log(
      `[knowledge] ${this.cfg.bot}: scheduler armed — first run in ${Math.round(firstDelay / 60000)} min (${hourUtc}:00 UTC daily)`,
    );

    return () => {
      clearTimeout(first);
      if (interval) clearInterval(interval);
    };
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.close();
    await this.logStore.close();
  }
}
