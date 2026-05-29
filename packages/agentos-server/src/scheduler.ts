// Scheduler — fires due agent schedules on a tick (default 60s).
//
// Each tick: read due schedules, advance nextRunAt, fire each one detached so
// a slow run never blocks the loop. The agent list is resolved fresh from the
// Mongo registry per fire (so newly-registered agents fire immediately, no
// restart needed). Final reply is recorded to the agent_logs store.

import { caBase } from "./upstream.js";
import { caAuthHeader } from "./auth.js";
import { scheduleStore, computeNextRun, type Schedule } from "./stores/schedule-store.js";
import { agentLogStore } from "./stores/agent-log-store.js";
import { resolveAgent, runBodyFor, type AgentDef } from "./agent-defs.js";

/** Run an agent once via /run and return the final assistant text. */
export async function runAgentOnce(agent: AgentDef, prompt: string): Promise<{ ok: boolean; text: string }> {
  let body: Record<string, unknown>;
  try {
    body = runBodyFor(agent, prompt);
  } catch (err) {
    return { ok: false, text: `bad agent config: ${(err as Error).message}` };
  }
  const r = await fetch(`${caBase()}/run`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...caAuthHeader() },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    return { ok: false, text: `run failed: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}` };
  }

  // Parse SSE — keep the latest final assistant text. Handles the
  // multi-dialect output (claude-agent-sdk, gitagent, deepagents).
  const reader = r.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let finalText = "";
  let daMsgCount = 0;
  // eslint-disable-next-line no-constant-condition
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
        else if (line.startsWith("data: ")) {
          try { data = JSON.parse(line.slice(6)); } catch { /* skip */ }
        }
      }
      if (ev === "ca_error") return { ok: false, text: String(data?.message ?? "error") };
      if (ev !== "sdk_message" || !data) continue;
      const p = data.payload ?? {};
      if (p.type === "assistant" && typeof p.message === "object" && p.message) {
        for (const b of (p.message.content ?? [])) {
          if (b?.type === "text" && typeof b.text === "string") finalText = b.text;
        }
      } else if (p.type === "assistant" && typeof p.content === "string") {
        finalText = p.content;
      } else if (p.type === "result" && typeof p.result === "string") {
        finalText = p.result;
      } else if (Array.isArray(p.messages)) {
        const newOnes = p.messages.slice(daMsgCount); daMsgCount = p.messages.length;
        for (const m of newOnes) {
          const k = (m.kwargs ?? m) as any;
          if ((m.id ?? []).join(".").includes("AIMessage") && typeof k.content === "string" && k.content.trim()) {
            finalText = k.content;
          }
        }
      }
    }
  }
  return { ok: true, text: finalText || "(no reply)" };
}

export function startScheduler(tickMs = 60_000): () => void {
  let running = false;

  const fire = async (sch: Schedule) => {
    const agent = await resolveAgent(sch.agentName);
    await scheduleStore.update(sch._id, {
      lastRunAt: new Date(),
      lastStatus: "running",
      nextRunAt: computeNextRun(sch, new Date()),
    });
    if (!agent) {
      await scheduleStore.update(sch._id, { lastStatus: "error", lastResult: `unknown agent: ${sch.agentName}` });
      return;
    }
    try {
      const res = await runAgentOnce(agent, sch.prompt);
      await scheduleStore.update(sch._id, {
        lastStatus: res.ok ? "ok" : "error",
        lastResult: res.text.slice(0, 2000),
      });
      await agentLogStore.append({
        source: "schedule", bot: sch.agentName, requester: "scheduler",
        channel: null, threadTs: null, sessionId: sch._id,
        query: sch.prompt, reply: res.text, ok: res.ok,
      }).catch(() => { /* best-effort */ });
    } catch (err) {
      await scheduleStore.update(sch._id, { lastStatus: "error", lastResult: (err as Error).message.slice(0, 2000) });
    }
  };

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const due = await scheduleStore.due();
      for (const sch of due) void fire(sch);
    } catch (err) {
      console.error("[scheduler] tick error:", (err as Error).message);
    } finally {
      running = false;
    }
  };

  const handle = setInterval(tick, tickMs);
  void tick();
  console.log(`[scheduler] started (tick ${tickMs / 1000}s)`);
  return () => clearInterval(handle);
}
