/**
 * Slack bot for ComputerAgent.
 *
 * Two bot apps in one service:
 *   POST /slack/claudebot/events  → drives a claude-agent-sdk sandbox
 *   POST /slack/gitagent/events   → drives a gitagent sandbox
 *
 * Each bot maps a Slack THREAD to a warm sandbox in ComputerAgent:
 *   - First `@bot` in a channel creates a new sandbox + thread mapping
 *   - Replies in the same thread reuse the sandbox via /sandboxes/:id/chat
 *   - Sandbox idle TTL fires (~30min) → autoSave snapshot lands in S3
 *   - Reply in the thread hours later → bot detects stale sandbox, restores
 *     from S3 snapshot, attaches the new sandboxId, continues
 *
 * Live progress: bot posts a "🤔 Working…" message immediately, then edits
 * it as the agent works (tool calls → "🔧 …", final answer replaces).
 *
 * Boots from computeragent-server.ts main() when SLACK_BOTS_ENABLED=1.
 *
 * Required env per bot:
 *   SLACK_<BOT>_TOKEN            xoxb-... (Bot User OAuth Token)
 *   SLACK_<BOT>_SIGNING_SECRET   Signing Secret from Slack app
 *   SLACK_<BOT>_SOURCE           GAP repo URL (e.g. github.com/org/repo)
 *
 * Common:
 *   MONGO_URL, MONGO_DATABASE    for the slack_threads collection
 *   S3_BUCKET                    for autoSave (already wired into main server)
 */

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";

// ── Types ────────────────────────────────────────────────────────────────

interface SlackEventCallback {
  type: "event_callback";
  event: SlackAppMentionEvent;
}
interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
}
interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;   // when responding inside a thread
  event_ts: string;
}

interface BotConfig {
  readonly name: "claudebot" | "gitagent";
  readonly harness: "claude-agent-sdk" | "gitagent";
  readonly token: string;
  readonly signingSecret: string;
  readonly source: string;
  /** Optional model id (used by gitagent's openai:<id>@<base> syntax). */
  readonly model?: string;
  /** Optional envs added to every sandbox this bot creates (e.g. Lyzr proxy / direct config). */
  readonly extraEnvs?: Record<string, string>;
}

interface ThreadDoc {
  _id: string;                  // "<bot>:<channel>:<rootTs>"
  bot: string;
  channel: string;
  threadTs: string;             // the Slack thread root ts
  sandboxId: string | null;     // null when sandbox has been disposed
  snapshotId: string | null;    // latest auto-save snapshot in S3
  sessionId: string;            // pinned: "slack-<channel>-<threadTs>"
  createdAt: Date;
  lastMessageAt: Date;
}

// ── Slack signature verification ─────────────────────────────────────────

/**
 * Verify a Slack Events API request is genuine.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 *
 * Inputs:
 *   X-Slack-Request-Timestamp  (Unix seconds; must be within 5 min of now)
 *   X-Slack-Signature          ("v0=<hex>")
 *   raw request body
 *
 * Compute HMAC-SHA256 over `v0:<ts>:<body>` using the signing secret;
 * compare to the v0= hex. Both must be timing-safe-equal.
 */
function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  signature: string,
  body: string,
): boolean {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  // 5-minute replay window per Slack docs.
  if (Math.abs(Date.now() / 1000 - tsNum) > 300) return false;
  if (!signature.startsWith("v0=")) return false;
  const base = `v0:${timestamp}:${body}`;
  const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  if (expected.length !== signature.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── Mongo thread store ───────────────────────────────────────────────────

class SlackThreadStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName;
  }

  private async coll(): Promise<Collection<ThreadDoc>> {
    if (!this.connected) {
      if (!this.connectPromise) {
        this.connectPromise = this.client.connect().then(() => { this.connected = true; });
      }
      await this.connectPromise;
    }
    return this.client.db(this.dbName).collection<ThreadDoc>("slack_threads");
  }

  key(bot: string, channel: string, threadTs: string): string {
    return `${bot}:${channel}:${threadTs}`;
  }

  async load(bot: string, channel: string, threadTs: string): Promise<ThreadDoc | null> {
    return (await this.coll()).findOne({ _id: this.key(bot, channel, threadTs) });
  }

  async upsert(
    bot: string, channel: string, threadTs: string,
    fields: Partial<Omit<ThreadDoc, "_id" | "bot" | "channel" | "threadTs">>,
  ): Promise<void> {
    const _id = this.key(bot, channel, threadTs);
    const sessionId = `slack-${channel}-${threadTs}`;
    const now = new Date();
    await (await this.coll()).updateOne(
      { _id },
      {
        $set: { lastMessageAt: now, ...fields },
        $setOnInsert: { _id, bot, channel, threadTs, sessionId, createdAt: now },
      },
      { upsert: true },
    );
  }
}

// ── Slack Web API client ─────────────────────────────────────────────────

interface SlackPostMessageResp { ok: boolean; channel?: string; ts?: string; error?: string; }
interface SlackUpdateResp { ok: boolean; ts?: string; error?: string; }

async function slackPost(token: string, channel: string, text: string, thread_ts?: string): Promise<SlackPostMessageResp> {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, text, ...(thread_ts ? { thread_ts } : {}) }),
  });
  return await r.json() as SlackPostMessageResp;
}

async function slackUpdate(token: string, channel: string, ts: string, text: string): Promise<SlackUpdateResp> {
  const r = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ channel, ts, text }),
  });
  return await r.json() as SlackUpdateResp;
}

// ── Sandbox lifecycle helpers ────────────────────────────────────────────

interface SandboxRef {
  sandboxId: string;
  fresh: boolean;       // true if just created (or restored), false if reusing live one
  fromSnapshot?: string;
}

/**
 * Resolve a thread to a live sandbox — reuse existing, restore from snapshot,
 * or create fresh. Returns the sandboxId the bot should /chat with.
 */
async function ensureSandboxForThread(
  caBase: string,
  store: SlackThreadStore,
  bot: BotConfig,
  channel: string,
  threadTs: string,
): Promise<SandboxRef> {
  const doc = await store.load(bot.name, channel, threadTs);
  const sessionId = `slack-${channel}-${threadTs}`;

  // ── Path A: existing live sandbox — verify it's actually still alive
  if (doc?.sandboxId) {
    const r = await fetch(`${caBase}/sandboxes/${encodeURIComponent(doc.sandboxId)}`);
    if (r.status === 200) {
      const j = await r.json() as { state: string };
      if (j.state !== "expired" && j.state !== "disposed") {
        return { sandboxId: doc.sandboxId, fresh: false };
      }
    }
    // sandbox is gone — clear the stale id so the next check sees only snapshotId
    await store.upsert(bot.name, channel, threadTs, { sandboxId: null });
  }

  // ── Path B: stale sandbox + snapshot — restore from S3
  if (doc?.snapshotId) {
    const r = await fetch(`${caBase}/sandboxes/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        snapshotId: doc.snapshotId,
        stateStore: { kind: "s3", options: { prefix: `slack/${bot.name}/` } },
        target: "new",
      }),
    });
    if (r.ok) {
      const j = await r.json() as { sandboxId: string };
      await store.upsert(bot.name, channel, threadTs, { sandboxId: j.sandboxId });
      return { sandboxId: j.sandboxId, fresh: true, fromSnapshot: doc.snapshotId };
    }
    // restore failed — fall through to fresh create
  }

  // ── Path C: brand-new sandbox
  const body: Record<string, unknown> = {
    source: bot.source,
    harness: bot.harness,
    runtime: "bwrap",
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    sessionId,
    sessionStore: { kind: "mongo" },
    autoSave: {
      stateStore: { kind: "s3", options: { prefix: `slack/${bot.name}/` } },
    },
    envs: bot.extraEnvs ?? {},
    idleTtlMs: 30 * 60_000,    // 30 min idle
    ttlMs: 4 * 60 * 60_000,    // 4h hard cap per thread
  };
  if (bot.model) body.model = bot.model;

  const r = await fetch(`${caBase}/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`sandbox create failed: ${r.status} ${errText.slice(0, 300)}`);
  }
  const j = await r.json() as { sandboxId: string };
  await store.upsert(bot.name, channel, threadTs, { sandboxId: j.sandboxId });
  return { sandboxId: j.sandboxId, fresh: true };
}

/**
 * Stream a chat turn through the sandbox, editing the Slack message live as
 * tool calls happen and finally with the assistant's last text.
 *
 * SSE event handling matches the multi-dialect parser we use in test.html and
 * scripts/test-sandboxes.py — claude-agent-sdk nested, gitagent flat,
 * deepagents LangGraph snapshots. (Deepagents isn't used here today, but the
 * parser tolerates it for future-proofing.)
 */
async function streamChatToSlack(
  caBase: string,
  bot: BotConfig,
  sandboxId: string,
  channel: string,
  msgTs: string,
  userText: string,
): Promise<void> {
  const r = await fetch(`${caBase}/sandboxes/${encodeURIComponent(sandboxId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "text/event-stream" },
    body: JSON.stringify({ message: userText }),
  });
  if (r.status === 409) {
    await slackUpdate(bot.token, channel, msgTs,
      "⏳ I'm already working on another reply in this thread. Wait for it to finish, then ask again.");
    return;
  }
  if (!r.ok || !r.body) {
    const text = await r.text();
    await slackUpdate(bot.token, channel, msgTs, `❌ Sandbox chat failed (${r.status}): ${text.slice(0, 400)}`);
    return;
  }

  let lastSlackText = "🤔 Working…";
  let finalText: string | null = null;
  let toolCount = 0;
  let lastToolName: string | null = null;
  let lastEditAt = 0;
  // Throttle edits to Slack — Slack rate-limits chat.update to ~1/sec/channel.
  const editDebounceMs = 800;

  const maybeEdit = async (newText: string, force = false): Promise<void> => {
    if (newText === lastSlackText) return;
    const now = Date.now();
    if (!force && now - lastEditAt < editDebounceMs) return;
    lastEditAt = now;
    lastSlackText = newText;
    await slackUpdate(bot.token, channel, msgTs, newText).catch(() => {});
  };

  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let daMsgCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = ""; let data: unknown = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) ev = line.slice(7);
        else if (line.startsWith("data: ")) {
          try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
      }
      if (!ev || !data) continue;

      if (ev === "sdk_message" && typeof data === "object" && data) {
        const p = (data as { payload?: Record<string, unknown> }).payload ?? {};
        // claude-agent-sdk
        if (p.type === "assistant" && typeof p.message === "object" && p.message) {
          const blocks = (p.message as { content?: unknown[] }).content ?? [];
          for (const b of blocks) {
            const bb = b as { type?: string; text?: string; name?: string };
            if (bb.type === "tool_use") {
              toolCount++; lastToolName = bb.name ?? "tool";
              await maybeEdit(`🔧 Running \`${lastToolName}\`… (${toolCount} tool${toolCount !== 1 ? "s" : ""} so far)`);
            } else if (bb.type === "text" && typeof bb.text === "string") {
              finalText = bb.text;
            }
          }
        }
        // gitagent flat
        else if (p.type === "tool_use") {
          toolCount++; lastToolName = (p.toolName as string) ?? (p.name as string) ?? "tool";
          await maybeEdit(`🔧 Running \`${lastToolName}\`… (${toolCount} tool${toolCount !== 1 ? "s" : ""})`);
        }
        else if (p.type === "assistant" && typeof p.content === "string") {
          finalText = p.content;
        }
        else if (p.type === "result" && typeof p.result === "string") {
          finalText = p.result;
        }
        // deepagents
        else if (Array.isArray((p as { messages?: unknown[] }).messages)) {
          const msgs = (p as { messages: unknown[] }).messages;
          const newOnes = msgs.slice(daMsgCount);
          daMsgCount = msgs.length;
          for (const m of newOnes) {
            const mm = m as { id?: string[]; kwargs?: Record<string, unknown> };
            const k = (mm.kwargs ?? mm) as Record<string, unknown>;
            const cls = (mm.id ?? []).join(".");
            const tcs = k.tool_calls as Array<{ name?: string }> | undefined;
            if (Array.isArray(tcs)) {
              for (const tc of tcs) {
                toolCount++; lastToolName = tc.name ?? "tool";
                await maybeEdit(`🔧 Running \`${lastToolName}\`… (${toolCount} tool${toolCount !== 1 ? "s" : ""})`);
              }
            }
            if (cls.includes("AIMessage") && typeof k.content === "string" && k.content.trim()) {
              finalText = k.content;
            }
          }
        }
      }
      else if (ev === "ca_error") {
        const msg = ((data as { message?: string }).message) ?? "Unknown error";
        await maybeEdit(`❌ ${msg}`, true);
        return;
      }
      else if (ev === "ca_session_ended") {
        break;
      }
    }
  }

  const reply = finalText && finalText.trim()
    ? finalText
    : "_(no reply text)_";
  await maybeEdit(reply, true);
}

// ── Slack event handler ─────────────────────────────────────────────────

/**
 * Strip the `<@U…>` mention prefix from Slack message text. Slack delivers
 * `app_mention.text` as e.g. `<@U07ABC> hi there` — the user-visible portion
 * is everything after the first whitespace.
 */
function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/, "").trim();
}

async function handleAppMention(
  caBase: string,
  store: SlackThreadStore,
  bot: BotConfig,
  ev: SlackAppMentionEvent,
): Promise<void> {
  // Reply IN-THREAD when there's a thread_ts, else start a thread on the message itself.
  const threadTs = ev.thread_ts ?? ev.ts;
  const userText = stripMention(ev.text);

  if (!userText) {
    await slackPost(bot.token, ev.channel,
      `👋 Mention me with a message — e.g. \`@${bot.name} summarize this channel\``,
      threadTs);
    return;
  }

  // Post the placeholder immediately so the user sees something.
  const placeholder = await slackPost(bot.token, ev.channel, "🤔 Working…", threadTs);
  if (!placeholder.ok || !placeholder.ts) {
    console.error("[slack-bot]", bot.name, "chat.postMessage failed:", placeholder.error);
    return;
  }

  try {
    const sb = await ensureSandboxForThread(caBase, store, bot, ev.channel, threadTs);
    if (sb.fromSnapshot) {
      await slackUpdate(bot.token, ev.channel, placeholder.ts,
        `📦 Restoring previous context from snapshot \`${sb.fromSnapshot}\`…`);
    }
    await streamChatToSlack(caBase, bot, sb.sandboxId, ev.channel, placeholder.ts, userText);
  } catch (err) {
    const msg = (err as Error).message ?? "unknown error";
    await slackUpdate(bot.token, ev.channel, placeholder.ts, `❌ Failed: ${msg.slice(0, 600)}`);
  }
}

// ── Hono app ─────────────────────────────────────────────────────────────

export interface SlackBotsOptions {
  /** ComputerAgent base URL (loopback). Default `http://127.0.0.1:9100`. */
  readonly caBase?: string;
  /** Mongo URL for the slack_threads collection. */
  readonly mongoUrl: string;
  /** Mongo database name. */
  readonly mongoDb: string;
  /** Bots to expose. */
  readonly bots: readonly BotConfig[];
}

export function createSlackBotsApp(opts: SlackBotsOptions): Hono {
  const caBase = (opts.caBase ?? "http://127.0.0.1:9100").replace(/\/+$/, "");
  const store = new SlackThreadStore(opts.mongoUrl, opts.mongoDb);
  const byName = new Map<string, BotConfig>(opts.bots.map((b) => [b.name, b]));

  const app = new Hono();

  // Health check that exercises mongo connectivity.
  app.get("/slack/health", async (c) => {
    try {
      const sample = await store.load("__health", "__health", "__health");
      return c.json({ ok: true, bots: opts.bots.map((b) => b.name), mongoConnected: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  });

  app.post("/slack/:bot/events", async (c) => {
    const botName = c.req.param("bot");
    const bot = byName.get(botName);
    if (!bot) return c.json({ error: "unknown bot" }, 404);

    const ts = c.req.header("x-slack-request-timestamp") ?? "";
    const sig = c.req.header("x-slack-signature") ?? "";
    const rawBody = await c.req.text();

    if (!verifySlackSignature(bot.signingSecret, ts, sig, rawBody)) {
      return c.json({ error: "invalid signature" }, 401);
    }

    let parsed: SlackEventCallback | SlackUrlVerification;
    try { parsed = JSON.parse(rawBody); }
    catch { return c.json({ error: "invalid json" }, 400); }

    // One-shot during Slack app setup — Slack POSTs a `url_verification` and
    // expects the `challenge` echoed back. Without this the Request URL field
    // stays unverified.
    if (parsed.type === "url_verification") {
      return c.json({ challenge: parsed.challenge });
    }

    if (parsed.type === "event_callback" && parsed.event?.type === "app_mention") {
      // ACK immediately so Slack doesn't retry. Real work happens detached.
      const ev = parsed.event;
      void handleAppMention(caBase, store, bot, ev).catch((err) => {
        console.error("[slack-bot]", bot.name, "handler crashed:", err);
      });
      return c.json({ ok: true });
    }

    return c.json({ ok: true });
  });

  return app;
}

// ── Env-driven bot config builder ────────────────────────────────────────

/**
 * Read SLACK_<BOT>_* env vars and produce a BotConfig array for each bot
 * that's fully configured. Bots missing any required env var are skipped
 * with a warning, so a partial deployment still boots cleanly.
 */
export function botsFromEnv(): BotConfig[] {
  const bots: BotConfig[] = [];
  const buildOne = (
    name: "claudebot" | "gitagent",
    harness: "claude-agent-sdk" | "gitagent",
  ): BotConfig | null => {
    const prefix = `SLACK_${name.toUpperCase()}_`;
    const token = process.env[`${prefix}TOKEN`];
    const signingSecret = process.env[`${prefix}SIGNING_SECRET`];
    const source = process.env[`${prefix}SOURCE`];
    if (!token || !signingSecret || !source) {
      if (token || signingSecret || source) {
        console.error(`[slack-bot] ${name}: partial config — need TOKEN + SIGNING_SECRET + SOURCE; skipping`);
      }
      return null;
    }
    // gitagent-specific: model + extra envs for Lyzr-direct path
    const extraEnvs: Record<string, string> = {};
    let model: string | undefined;
    if (harness === "gitagent") {
      // Default to Lyzr-direct config when LYZR_UPSTREAM_* is set.
      const lyzrBase = process.env.LYZR_UPSTREAM_BASE;
      const lyzrToken = process.env.LYZR_UPSTREAM_TOKEN;
      const lyzrModel = process.env.LYZR_UPSTREAM_MODEL;
      if (lyzrBase && lyzrToken && lyzrModel) {
        extraEnvs.GITCLAW_MODEL_BASE_URL = lyzrBase.replace(/\/+$/, "") + "/v4";
        extraEnvs.OPENAI_API_KEY = lyzrToken;
        model = `openai:${lyzrModel}`;
      }
    } else if (harness === "claude-agent-sdk") {
      // Default to local proxy when LYZR_PROXY_ENABLED=1.
      if (process.env.LYZR_PROXY_ENABLED === "1") {
        const port = process.env.LYZR_PROXY_PORT ?? "8788";
        extraEnvs.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
        extraEnvs.ANTHROPIC_API_KEY = "lyzr-via-proxy";
      }
    }
    return { name, harness, token, signingSecret, source, ...(model ? { model } : {}), extraEnvs };
  };

  const claudebot = buildOne("claudebot", "claude-agent-sdk");
  if (claudebot) bots.push(claudebot);
  const gitagent = buildOne("gitagent", "gitagent");
  if (gitagent) bots.push(gitagent);
  return bots;
}
