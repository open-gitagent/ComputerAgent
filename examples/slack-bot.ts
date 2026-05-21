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

// ── Loopback auth ────────────────────────────────────────────────────────
//
// When the parent server has API_AUTH_USER + API_AUTH_PASS set, every request
// to /sandboxes/* requires HTTP Basic Auth. The slack-bot makes loopback HTTP
// calls to that same server, so it also needs to send the credentials.
// Reads the same env vars; no separate config.
function caAuthHeader(): Record<string, string> {
  const u = process.env.API_AUTH_USER;
  const p = process.env.API_AUTH_PASS;
  if (!u || !p) return {};
  return { authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") };
}

// ── Types ────────────────────────────────────────────────────────────────

interface SlackEventCallback {
  type: "event_callback";
  event: SlackAppMentionEvent;
}
interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
}
interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
}
interface SlackAppMentionEvent {
  type: "app_mention";
  user: string;
  text: string;
  channel: string;
  ts: string;
  thread_ts?: string;   // when responding inside a thread
  event_ts: string;
  files?: SlackFile[];  // present when the user attached files to the message
}

interface ChatAttachment { path: string; content: string; encoding: "base64" | "utf8"; }

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
  /** Optional GitHub PAT used to clone private GAP repos. Server bakes it into the clone URL. */
  readonly gitToken?: string;
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
  ingestedFileIds?: string[];   // Slack file IDs already pulled into the sandbox
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

// Files uploaded by the user that exceed this are skipped (base64 in JSON gets
// unwieldy; large docs belong in object storage, not an inline chat attachment).
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Sanitize a Slack-provided filename into a safe workdir-relative path. */
function safeFilename(name: string | undefined, idx: number): string {
  const base = (name ?? `upload_${idx}`).split("/").pop() ?? `upload_${idx}`;
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  return cleaned || `upload_${idx}`;
}

/**
 * Fetch all files attached anywhere in a Slack thread (root + replies). Used
 * when the user uploads a file on one message and mentions the bot on another.
 * Needs a history scope: `channels:history` (public) / `groups:history`
 * (private) / `im:history` / `mpim:history`.
 */
async function fetchThreadFiles(token: string, channel: string, threadTs: string): Promise<SlackFile[]> {
  const files: SlackFile[] = [];
  try {
    const r = await fetch(
      `https://slack.com/api/conversations.replies?channel=${encodeURIComponent(channel)}&ts=${encodeURIComponent(threadTs)}&limit=200`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const j = await r.json() as { ok: boolean; error?: string; messages?: Array<{ files?: SlackFile[] }> };
    if (!j.ok) { console.error("[slack-bot] conversations.replies failed:", j.error); return files; }
    for (const m of j.messages ?? []) {
      for (const f of m.files ?? []) files.push(f);
    }
  } catch (err) {
    console.error("[slack-bot] fetchThreadFiles error:", (err as Error).message);
  }
  return files;
}

/**
 * Download files the user attached to a Slack message and return them as chat
 * attachments (base64) to materialize into the sandbox workdir. Slack file URLs
 * require the bot token as a Bearer header. Needs the `files:read` scope.
 */
async function downloadSlackFiles(token: string, files: SlackFile[] | undefined): Promise<{ attachments: ChatAttachment[]; names: string[]; skipped: string[] }> {
  const attachments: ChatAttachment[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  for (let i = 0; i < (files?.length ?? 0); i++) {
    const f = files![i];
    const url = f.url_private_download ?? f.url_private;
    if (!url) { skipped.push(f.name ?? f.id); continue; }
    if (f.size && f.size > MAX_UPLOAD_BYTES) { skipped.push(`${f.name ?? f.id} (too large)`); continue; }
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { skipped.push(`${f.name ?? f.id} (HTTP ${r.status})`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.byteLength > MAX_UPLOAD_BYTES) { skipped.push(`${f.name ?? f.id} (too large)`); continue; }
      const path = safeFilename(f.name ?? f.title, i);
      attachments.push({ path, content: buf.toString("base64"), encoding: "base64" });
      names.push(path);
    } catch (err) {
      skipped.push(`${f.name ?? f.id} (${(err as Error).message})`);
    }
  }
  return { attachments, names, skipped };
}

/**
 * Upload a file as a Slack thread attachment using the files.upload_v2 flow.
 * Three steps:
 *   1. files.getUploadURLExternal → pre-signed upload URL + file_id
 *   2. POST the bytes to that URL (multipart)
 *   3. files.completeUploadExternal → publish into the channel/thread
 * Requires the bot to have the `files:write` scope.
 */
async function slackUploadFile(
  token: string, channel: string, thread_ts: string,
  filename: string, bytes: Uint8Array,
): Promise<{ ok: boolean; error?: string }> {
  // Step 1: get the upload URL
  const step1 = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ filename, length: String(bytes.byteLength) }),
  });
  const j1 = await step1.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
  if (!j1.ok || !j1.upload_url || !j1.file_id) {
    return { ok: false, error: `getUploadURLExternal: ${j1.error ?? "unknown"}` };
  }

  // Step 2: upload bytes to the pre-signed URL
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart]), filename);
  const step2 = await fetch(j1.upload_url, { method: "POST", body: form });
  if (!step2.ok) {
    return { ok: false, error: `upload bytes: HTTP ${step2.status}` };
  }

  // Step 3: complete the upload and post to the channel thread
  const step3 = await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      files: [{ id: j1.file_id, title: filename }],
      channel_id: channel,
      thread_ts,
    }),
  });
  const j3 = await step3.json() as { ok: boolean; error?: string };
  if (!j3.ok) return { ok: false, error: `completeUploadExternal: ${j3.error ?? "unknown"}` };
  return { ok: true };
}

// ── Workdir snapshot + deliverable detection ─────────────────────────────

// Binary / data formats that are almost always intended as deliverables when
// freshly created during a turn. We auto-attach these even without an explicit
// [[ATTACH:]] marker, as a safety net for when the agent forgets the marker.
// Intermediates the agent commonly writes (.py, .json, .html, .md, .txt, .log,
// .sh) are deliberately excluded — attach those only via an explicit marker.
const DELIVERABLE_EXTS = new Set([
  "pdf", "pptx", "ppt", "docx", "doc", "xlsx", "xls", "csv",
  "png", "jpg", "jpeg", "gif", "svg", "webp",
  "zip", "tar", "gz", "mp3", "mp4", "wav",
]);

interface WorkdirEntry { path: string; type: "file" | "dir"; size: number; mtime: number; }

/** Map of file path -> "size:mtime" signature, for diffing before/after a turn. */
async function snapshotWorkdir(caBase: string, sandboxId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const r = await fetch(
      `${caBase}/sandboxes/${encodeURIComponent(sandboxId)}/workdir?depth=3`,
      { headers: caAuthHeader() },
    );
    if (!r.ok) return out;
    const j = await r.json() as { entries?: WorkdirEntry[] };
    for (const e of j.entries ?? []) {
      if (e.type === "file") out.set(e.path, `${e.size}:${e.mtime}`);
    }
  } catch { /* best-effort — empty snapshot just disables auto-attach */ }
  return out;
}

function extOf(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** New-or-changed deliverable files between two workdir snapshots. */
function newDeliverables(before: Map<string, string>, after: Map<string, string>): string[] {
  const result: string[] = [];
  for (const [path, sig] of after) {
    if (!DELIVERABLE_EXTS.has(extOf(path))) continue;
    if (before.get(path) !== sig) result.push(path);   // new or changed
  }
  return result;
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
    const r = await fetch(`${caBase}/sandboxes/${encodeURIComponent(doc.sandboxId)}`, {
      headers: caAuthHeader(),
    });
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
      headers: { "content-type": "application/json", ...caAuthHeader() },
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
  if (bot.gitToken) body.gitToken = bot.gitToken;

  const r = await fetch(`${caBase}/sandboxes`, {
    method: "POST",
    headers: { "content-type": "application/json", ...caAuthHeader() },
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
  attachments: ChatAttachment[] = [],
): Promise<void> {
  // Snapshot the workdir BEFORE the turn so we can auto-attach any deliverable
  // files the agent creates — a safety net for when it forgets the [[ATTACH]] marker.
  const beforeFiles = await snapshotWorkdir(caBase, sandboxId);

  const chatBody: Record<string, unknown> = { message: userText };
  if (attachments.length > 0) chatBody.attachments = attachments;

  const r = await fetch(`${caBase}/sandboxes/${encodeURIComponent(sandboxId)}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "text/event-stream", ...caAuthHeader() },
    body: JSON.stringify(chatBody),
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

  // Parse [[ATTACH:path]] markers from the final reply text. The agent emits these
  // to signal that a workdir file should be uploaded to Slack as a thread attachment.
  // Markers are stripped from the user-visible text before the final edit.
  const rawReply = finalText && finalText.trim() ? finalText : "_(no reply text)_";
  const marked: string[] = [];
  const cleanedReply = rawReply.replace(/\[\[ATTACH:([^\]]+)\]\]/g, (_m, p) => {
    marked.push(String(p).trim());
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim() || rawReply;

  // Slack's chat.update rejects text beyond ~3000 chars (the edit fails and, if
  // swallowed, leaves the message frozen on the last progress text). For long
  // replies: show a preview in the message and attach the full text as a file.
  const SLACK_TEXT_LIMIT = 2900;
  if (cleanedReply.length <= SLACK_TEXT_LIMIT) {
    const res = await slackUpdate(bot.token, channel, msgTs, cleanedReply);
    if (!res.ok) console.error("[slack-bot]", bot.name, "final chat.update failed:", res.error);
  } else {
    const preview = cleanedReply.slice(0, SLACK_TEXT_LIMIT - 120).trimEnd();
    const res = await slackUpdate(bot.token, channel, msgTs,
      `${preview}\n\n…_(full response attached below as \`response.md\`)_`);
    if (!res.ok) console.error("[slack-bot]", bot.name, "final chat.update failed:", res.error);
    // Upload the complete reply as a Markdown file in the thread.
    const up = await slackUploadFile(bot.token, channel, msgTs, "response.md",
      new TextEncoder().encode(cleanedReply));
    if (!up.ok) console.error("[slack-bot]", bot.name, "response.md upload failed:", up.error);
  }

  // SAFETY NET: even if the agent forgot the [[ATTACH]] marker, auto-attach any
  // deliverable files (pdf/pptx/csv/png/…) it created or changed during this turn.
  // Merge with the explicitly-marked paths, dedupe. Exclude the user's own
  // uploaded files — we materialized those into the workdir, don't echo them back.
  const afterFiles = await snapshotWorkdir(caBase, sandboxId);
  const uploadedPaths = new Set(attachments.map((a) => a.path));
  const auto = newDeliverables(beforeFiles, afterFiles).filter((p) => !uploadedPaths.has(p));
  const toUpload = Array.from(new Set([...marked, ...auto]));

  // Fetch each file from the sandbox workdir and upload to the Slack thread.
  let uploaded = 0;
  for (const path of toUpload) {
    try {
      const r = await fetch(`${caBase}/sandboxes/${encodeURIComponent(sandboxId)}/artifact?path=${encodeURIComponent(path)}`, {
        headers: caAuthHeader(),
      });
      if (!r.ok) {
        console.error("[slack-bot]", bot.name, "artifact fetch failed", path, r.status);
        continue;
      }
      const buf = new Uint8Array(await r.arrayBuffer());
      const filename = path.split("/").pop() || path;
      const up = await slackUploadFile(bot.token, channel, msgTs, filename, buf);
      if (up.ok) uploaded++;
      else console.error("[slack-bot]", bot.name, "slack upload failed for", filename, up.error);
    } catch (err) {
      console.error("[slack-bot]", bot.name, "attachment error for", path, (err as Error).message);
    }
  }

  // If we auto-attached files the agent didn't mention, nudge the reply so the
  // thread isn't just a bare file with stale "it's in the workdir" text.
  if (uploaded > 0 && marked.length === 0) {
    const noun = uploaded === 1 ? "the file" : `${uploaded} files`;
    if (!/attach|here|below|deliver/i.test(cleanedReply)) {
      await slackUpdate(bot.token, channel, msgTs, `${cleanedReply}\n\n_(Attached ${noun} above.)_`).catch(() => {});
    }
  }
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
  const hasFiles = (ev.files?.length ?? 0) > 0;

  // Allow a file-only mention (no text) — the attached file IS the task context.
  if (!userText && !hasFiles) {
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
    // Resolve the sandbox first — we need to know whether the workdir is fresh
    // (empty) or carried over, because that decides whether previously-ingested
    // files still physically exist in the workdir.
    const sb = await ensureSandboxForThread(caBase, store, bot, ev.channel, threadTs);
    if (sb.fromSnapshot) {
      await slackUpdate(bot.token, ev.channel, placeholder.ts,
        `📦 Restoring previous context from snapshot \`${sb.fromSnapshot}\`…`);
    }

    // A brand-new sandbox with NO snapshot has an empty workdir, so the dedup
    // record is stale — clear it and re-ingest. A reused or snapshot-restored
    // sandbox still has the files, so honor the dedup record and skip re-download.
    const workdirIsFresh = sb.fresh && !sb.fromSnapshot;
    const doc = await store.load(bot.name, ev.channel, threadTs);
    const alreadyIngested = workdirIsFresh ? new Set<string>() : new Set(doc?.ingestedFileIds ?? []);
    if (workdirIsFresh && (doc?.ingestedFileIds?.length ?? 0) > 0) {
      await store.upsert(bot.name, ev.channel, threadTs, { ingestedFileIds: [] });
    }

    // Gather files to ingest. Prefer files on THIS mention; if it has none, fall
    // back to scanning the thread (user often uploads to the root message, then
    // mentions the bot in a reply). Dedup against files already pulled in.
    let candidateFiles: SlackFile[] = ev.files ?? [];
    if (candidateFiles.length === 0) {
      candidateFiles = await fetchThreadFiles(bot.token, ev.channel, threadTs);
    }
    const newFiles = candidateFiles.filter((f) => f.id && !alreadyIngested.has(f.id));

    let attachments: ChatAttachment[] = [];
    let fileNote = "";
    if (newFiles.length > 0) {
      await slackUpdate(bot.token, ev.channel, placeholder.ts, "📎 Downloading file(s)…");
      const dl = await downloadSlackFiles(bot.token, newFiles);
      attachments = dl.attachments;
      if (dl.names.length > 0) {
        fileNote = `The user attached ${dl.names.length} file(s), saved in your working directory: ${dl.names.map((n) => `\`${n}\``).join(", ")}. Read them as needed to answer.`;
        // Record these so we don't re-download them on every follow-up mention.
        const ingestedIds = [...alreadyIngested, ...newFiles.map((f) => f.id)];
        await store.upsert(bot.name, ev.channel, threadTs, { ingestedFileIds: ingestedIds });
      }
      if (dl.skipped.length > 0) {
        await slackUpdate(bot.token, ev.channel, placeholder.ts,
          `⚠️ Couldn't attach: ${dl.skipped.join(", ")}. Continuing…`);
      }
    }

    // Prepend a note about the uploaded files so the agent knows they exist and where.
    const message = fileNote
      ? (userText ? `${fileNote}\n\n${userText}` : fileNote)
      : userText;
    await streamChatToSlack(caBase, bot, sb.sandboxId, ev.channel, placeholder.ts, message, attachments);
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
    // Optional GitHub PAT for private repos. Per-bot override wins over the global GITHUB_TOKEN.
    // The token is used in two places:
    //   1. `gitToken` — server-side, baked into the clone URL when fetching the GAP repo
    //   2. Sandbox envs (GITHUB_TOKEN + GH_TOKEN) — so the agent itself can clone private
    //      repos when the user asks it to from Slack.
    const gitToken = process.env[`${prefix}GIT_TOKEN`] ?? process.env.GITHUB_TOKEN;
    if (gitToken) {
      extraEnvs.GITHUB_TOKEN = gitToken;
      extraEnvs.GH_TOKEN = gitToken;       // gh CLI reads GH_TOKEN
    }
    // Slack user ID to @-mention when the agent thinks a PR review is approve-worthy.
    // The agent emits `<@USERID>` into its final reply text; Slack renders the mention.
    const approver = process.env[`${prefix}APPROVER_USER_ID`] ?? process.env.SLACK_APPROVER_USER_ID;
    if (approver) {
      extraEnvs.SLACK_APPROVER_USER_ID = approver;
    }
    // Exa API key for the exa-research skill. Per-bot override allowed.
    const exaKey = process.env[`${prefix}EXA_API_KEY`] ?? process.env.EXA_API_KEY;
    if (exaKey) {
      extraEnvs.EXA_API_KEY = exaKey;
    }
    return {
      name, harness, token, signingSecret, source,
      ...(model ? { model } : {}),
      extraEnvs,
      ...(gitToken ? { gitToken } : {}),
    };
  };

  const claudebot = buildOne("claudebot", "claude-agent-sdk");
  if (claudebot) bots.push(claudebot);
  const gitagent = buildOne("gitagent", "gitagent");
  if (gitagent) bots.push(gitagent);
  return bots;
}
