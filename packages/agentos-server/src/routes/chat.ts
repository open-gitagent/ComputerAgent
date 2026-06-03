// Chat surface — warm sandbox creation, SSE proxy, artifact, "new chat" pin
// deletion. The harness owns sandbox lifecycle; we just orchestrate session
// pinning and pipe its SSE back to the browser.
//
//   POST   /agentos/api/agents/:name/chat-sandbox
//   DELETE /agentos/api/agents/:name/chat-pin
//   POST   /agentos/api/sandboxes/:id/chat       (SSE)
//   GET    /agentos/api/sandboxes/:id/artifact   (binary)

import { Router, type Router as IRouter } from "express";
import { randomUUID } from "node:crypto";
import { caAuthHeader } from "../auth.js";
import { caBase, pipeUpstream } from "../upstream.js";
import { chatPinsColl, threadsColl } from "../mongo.js";
import { hasResolvableSource, resolveAgent, sandboxBodyFor, sandboxCapable } from "../agent-defs.js";

export const chatRouter: IRouter = Router();

chatRouter.post("/agents/:name/chat-sandbox", async (req, res, next) => {
  try {
    const name = req.params["name"]!;
    const agent = await resolveAgent(name);
    if (!agent) return res.status(404).json({ error: { code: "UNKNOWN_AGENT" } });
    if (!sandboxCapable(agent.harness)) {
      return res.status(400).json({
        error: { code: "NO_SANDBOX", message: `${agent.label} runs one-shot — use /run` },
      });
    }
    // Refuse cleanly if the agent's source can't be resolved into a harness
    // workdir (legacy "library agents had no files" case — kept as a
    // safety net for old registry rows). Library-mode agents written by the
    // Python SDK now ship a full inline source with `files: {agent.yaml,
    // CLAUDE.md}` so this guard passes and the harness's inline loader
    // materializes the workdir from those files.
    if (!hasResolvableSource(agent.source)) {
      return res.status(400).json({
        error: {
          code: "LIBRARY_AGENT_NO_LIVE_CHAT",
          message:
            `${agent.label} has no resolvable identity source (no git URL, local path, ` +
            `or inline files). Historical sessions remain visible in the Chat tab, ` +
            `but starting a new live conversation needs a runnable source.`,
        },
      });
    }

    const body = (req.body ?? {}) as { sessionId?: string };
    // Resume order: explicit body > pinned > new
    let sessionId = body.sessionId;
    if (!sessionId) {
      try {
        const pin = await (await chatPinsColl()).findOne({ _id: agent.name });
        if (pin?.sessionId) sessionId = pin.sessionId;
      } catch { /* fall through */ }
    }
    if (!sessionId) sessionId = `agentos-${agent.name}-${randomUUID().slice(0, 12)}`;

    const tryCreate = async (sid: string) => {
      let body: Record<string, unknown>;
      try {
        body = sandboxBodyFor(agent, sid);
      } catch (err) {
        // defaultEnvsFor throws if ANTHROPIC_API_KEY missing for Claude.
        const status = (err as any)?.status ?? 503;
        return { ok: false as const, status, code: "AGENT_CONFIG", detail: (err as Error).message };
      }
      const r = await fetch(`${caBase()}/sandboxes`, {
        method: "POST",
        headers: { "content-type": "application/json", ...caAuthHeader() },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const j = (await r.json()) as { sandboxId: string };
        return { ok: true as const, sandboxId: j.sandboxId };
      }
      const text = await r.text().catch(() => "");
      return { ok: false as const, status: 502, code: "SANDBOX_CREATE_FAILED", detail: text.slice(0, 500) };
    };

    let result = await tryCreate(sessionId);

    // Recover from a stale-workdir collision: the previous sandbox died but
    // left its git workdir behind, so the harness's `local` runtime refuses
    // to clone into an existing non-empty path. We detect that, drop the pin
    // (the old conversation memory is gone anyway since the sandbox died),
    // and retry with a fresh sessionId so the harness picks a clean workdir.
    if (
      !result.ok &&
      result.code === "SANDBOX_CREATE_FAILED" &&
      /already exists and is not an empty directory|destination path .* already exists/i.test(result.detail ?? "")
    ) {
      try { await (await chatPinsColl()).deleteOne({ _id: agent.name }); } catch { /* best-effort */ }
      sessionId = `agentos-${agent.name}-${randomUUID().slice(0, 12)}`;
      result = await tryCreate(sessionId);
    }

    if (!result.ok) {
      return res.status(result.status).json({
        error: { code: result.code, detail: result.detail },
      });
    }
    const j = { sandboxId: result.sandboxId };

    try {
      await (await chatPinsColl()).updateOne(
        { _id: agent.name },
        { $set: { sessionId, updatedAt: new Date() } },
        { upsert: true },
      );
    } catch { /* best-effort */ }

    // Write a synthetic slack_threads row so the Sessions tab sees web chats
    // uniformly with Slack threads. channel="web", threadTs=sessionId.
    try {
      const now = new Date();
      await (await threadsColl()).updateOne(
        { _id: `web:${sessionId}` },
        {
          $set: {
            bot: agent.name,
            channel: "web",
            threadTs: sessionId,
            sessionId,
            sandboxId: j.sandboxId,
            snapshotId: null,
            lastMessageAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      );
    } catch { /* best-effort */ }

    res.json({ sandboxId: j.sandboxId, sessionId, bot: agent.name });
  } catch (err) { next(err); }
});

chatRouter.delete("/agents/:name/chat-pin", async (req, res, next) => {
  try {
    await (await chatPinsColl()).deleteOne({ _id: req.params["name"]! });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// SSE proxy — pipe the upstream /sandboxes/:id/chat stream to the browser.
chatRouter.post("/sandboxes/:id/chat", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const upstream = await fetch(`${caBase()}/sandboxes/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
      body: JSON.stringify(req.body ?? {}),
    });
    await pipeUpstream(upstream, res);
  } catch (err) { next(err); }
});

// Binary artifact pass-through.
chatRouter.get("/sandboxes/:id/artifact", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const path = typeof req.query["path"] === "string" ? req.query["path"] : "";
    const upstream = await fetch(
      `${caBase()}/sandboxes/${encodeURIComponent(id)}/artifact?path=${encodeURIComponent(path)}`,
      { headers: caAuthHeader() },
    );
    await pipeUpstream(upstream, res);
  } catch (err) { next(err); }
});
