// Schedules CRUD + run-now. The in-process scheduler tick (src/scheduler.ts)
// reads from the same store, so a created schedule fires on its own cadence.

import { Router, type Router as IRouter } from "express";
import {
  scheduleStore,
  computeNextRun,
  describeSchedule,
  type ScheduleKind,
} from "../stores/schedule-store.js";
import { agentLogStore } from "../stores/agent-log-store.js";
import { resolveAgent } from "../agent-defs.js";
import { runAgentOnce } from "../scheduler.js";

export const schedulesRouter: IRouter = Router();

const withDesc = <T extends { kind: ScheduleKind; intervalMinutes?: number; hourUtc?: number; minuteUtc?: number }>(
  s: T,
): T & { description: string } => ({ ...s, description: describeSchedule(s as any) });

schedulesRouter.get("/schedules", async (req, res, next) => {
  try {
    const agent = typeof req.query["agent"] === "string" ? req.query["agent"] : undefined;
    const list = await scheduleStore.list(agent);
    res.json({ schedules: list.map(withDesc) });
  } catch (err) { next(err); }
});

schedulesRouter.post("/schedules", async (req, res, next) => {
  try {
    const b = (req.body ?? {}) as Record<string, any>;
    const agentName = String(b.agentName ?? "");
    if (!agentName || !(await resolveAgent(agentName))) {
      return res.status(400).json({ error: { code: "UNKNOWN_AGENT" } });
    }
    if (!b.prompt || !String(b.prompt).trim()) {
      return res.status(400).json({ error: { code: "MISSING_PROMPT" } });
    }
    const kind: ScheduleKind = b.kind === "daily" ? "daily" : "interval";
    const created = await scheduleStore.create({
      agentName,
      prompt: String(b.prompt),
      kind,
      intervalMinutes: kind === "interval" ? Math.max(1, Number(b.intervalMinutes) || 60) : undefined,
      hourUtc: kind === "daily" ? Math.min(23, Math.max(0, Number(b.hourUtc) || 0)) : undefined,
      minuteUtc: kind === "daily" ? Math.min(59, Math.max(0, Number(b.minuteUtc) || 0)) : undefined,
      enabled: b.enabled !== false,
    });
    res.json({ schedule: withDesc(created) });
  } catch (err) { next(err); }
});

schedulesRouter.patch("/schedules/:id", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const existing = await scheduleStore.get(id);
    if (!existing) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const b = (req.body ?? {}) as Record<string, any>;
    const fields: Record<string, unknown> = {};
    if (typeof b.enabled === "boolean") fields["enabled"] = b.enabled;
    if (b.prompt !== undefined) fields["prompt"] = String(b.prompt);
    const spec = {
      kind: existing.kind,
      intervalMinutes: existing.intervalMinutes,
      hourUtc: existing.hourUtc,
      minuteUtc: existing.minuteUtc,
      ...b,
    };
    if (b.kind || b.intervalMinutes !== undefined || b.hourUtc !== undefined || b.minuteUtc !== undefined) {
      Object.assign(fields, {
        kind: spec.kind,
        intervalMinutes: spec.intervalMinutes,
        hourUtc: spec.hourUtc,
        minuteUtc: spec.minuteUtc,
        nextRunAt: computeNextRun(spec as any),
      });
    }
    await scheduleStore.update(id, fields);
    const updated = await scheduleStore.get(id);
    res.json({ schedule: updated ? withDesc(updated) : null });
  } catch (err) { next(err); }
});

schedulesRouter.delete("/schedules/:id", async (req, res, next) => {
  try {
    await scheduleStore.delete(req.params["id"]!);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

schedulesRouter.post("/schedules/:id/run-now", async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const s = await scheduleStore.get(id);
    if (!s) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    const agent = await resolveAgent(s.agentName);
    if (!agent) return res.status(400).json({ error: { code: "UNKNOWN_AGENT" } });
    await scheduleStore.update(s._id, { lastRunAt: new Date(), lastStatus: "running" });
    void (async () => {
      const result = await runAgentOnce(agent, s.prompt).catch((e: unknown) => ({
        ok: false, text: String(e),
      }));
      await scheduleStore.update(s._id, {
        lastStatus: result.ok ? "ok" : "error",
        lastResult: result.text.slice(0, 2000),
      });
      await agentLogStore.append({
        source: "schedule",
        bot: s.agentName,
        requester: "manual-run",
        channel: null,
        threadTs: null,
        sessionId: s._id,
        query: s.prompt,
        reply: result.text,
        ok: result.ok,
      }).catch(() => { /* best-effort */ });
    })();
    res.json({ ok: true, running: true });
  } catch (err) { next(err); }
});
