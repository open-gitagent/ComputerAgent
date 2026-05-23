/**
 * Scheduler — fires due agent schedules on a tick.
 *
 * Every tick (default 60s) it reads due schedules, advances each one's
 * nextRunAt, and runs the agent one-shot via the loopback POST /run. The final
 * reply is captured and recorded to the agent log (source: "schedule").
 *
 * Runs are fired detached so a slow run never blocks the tick loop.
 */
import { ScheduleStore, computeNextRun, type Schedule } from "./schedule-store.ts";
import { AgentLogStore } from "./agent-log-store.ts";
import type { AgentDef } from "./agentos-api.ts";

interface SchedulerOptions {
  caBase: string;
  authHeader: Record<string, string>;
  store: ScheduleStore;
  logStore: AgentLogStore;
  agents: readonly AgentDef[];
  tickMs?: number;
}

/** Run an agent once via /run and return the final assistant text. */
export async function runAgentOnce(
  caBase: string, authHeader: Record<string, string>, agent: AgentDef, prompt: string,
): Promise<{ ok: boolean; text: string }> {
  const body: Record<string, unknown> = {
    source: agent.source,
    harness: agent.harness,
    runtime: "bwrap",
    options: { permissionMode: "bypassPermissions", settingSources: ["project"] },
    envs: agent.envs ?? {},
    message: prompt,
  };
  if (agent.model) body.model = agent.model;
  if (agent.gitToken) body.gitToken = agent.gitToken;

  const r = await fetch(`${caBase}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...authHeader },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) return { ok: false, text: `run failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` };

  // Parse the multi-dialect SSE stream and keep the latest final text.
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let finalText = "";
  let daMsgCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      let ev = ""; let data: any = null;
      for (const line of frame.split("\n")) {
        if (line.startsWith("event: ")) ev = line.slice(7);
        else if (line.startsWith("data: ")) { try { data = JSON.parse(line.slice(6)); } catch { /* skip */ } }
      }
      if (ev === "ca_error") return { ok: false, text: String(data?.message ?? "error") };
      if (ev !== "sdk_message" || !data) continue;
      const p = data.payload ?? {};
      if (p.type === "assistant" && typeof p.message === "object" && p.message) {
        for (const b of (p.message.content ?? [])) if (b?.type === "text" && typeof b.text === "string") finalText = b.text;
      } else if (p.type === "assistant" && typeof p.content === "string") finalText = p.content;
      else if (p.type === "result" && typeof p.result === "string") finalText = p.result;
      else if (Array.isArray(p.messages)) {
        const newOnes = p.messages.slice(daMsgCount); daMsgCount = p.messages.length;
        for (const m of newOnes) {
          const k = (m.kwargs ?? m) as any;
          if ((m.id ?? []).join(".").includes("AIMessage") && typeof k.content === "string" && k.content.trim()) finalText = k.content;
        }
      }
    }
  }
  return { ok: true, text: finalText || "(no reply)" };
}

export function startScheduler(opts: SchedulerOptions): () => void {
  const tickMs = opts.tickMs ?? 60_000;
  const byName = new Map(opts.agents.map((a) => [a.name, a]));
  let running = false;

  const fire = async (sch: Schedule) => {
    const agent = byName.get(sch.agentName);
    // Advance nextRunAt + mark running immediately so we don't double-fire.
    await opts.store.update(sch._id, {
      lastRunAt: new Date(),
      lastStatus: "running",
      nextRunAt: computeNextRun(sch, new Date()),
    });
    if (!agent) {
      await opts.store.update(sch._id, { lastStatus: "error", lastResult: `unknown agent: ${sch.agentName}` });
      return;
    }
    try {
      const res = await runAgentOnce(opts.caBase, opts.authHeader, agent, sch.prompt);
      await opts.store.update(sch._id, {
        lastStatus: res.ok ? "ok" : "error",
        lastResult: res.text.slice(0, 2000),
      });
      await opts.logStore.append({
        source: "schedule", bot: sch.agentName, requester: "scheduler",
        channel: null, threadTs: null, sessionId: sch._id,
        query: sch.prompt, reply: res.text, ok: res.ok,
      }).catch(() => {});
    } catch (err) {
      await opts.store.update(sch._id, { lastStatus: "error", lastResult: (err as Error).message.slice(0, 2000) });
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await opts.store.due();
      for (const sch of due) void fire(sch);   // detached — don't block the loop
    } catch (err) {
      console.error("[scheduler] tick error:", (err as Error).message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, tickMs);
  void tick();   // run once at boot
  console.log(`[scheduler] started (tick ${tickMs / 1000}s)`);
  return () => clearInterval(handle);
}
