// Agent run schedules in MongoDB (`agent_schedules`).
// Each schedule fires a one-shot agent run on a cadence: fixed interval
// (every N minutes) or daily at a UTC time. The scheduler tick reads due
// schedules and runs them.

import { type Collection } from "mongodb";
import { randomUUID } from "node:crypto";
import { getDb } from "../mongo.js";

export type ScheduleKind = "interval" | "daily";

export interface Schedule {
  _id: string;
  agentName: string;
  prompt: string;
  kind: ScheduleKind;
  intervalMinutes?: number;
  hourUtc?: number;
  minuteUtc?: number;
  enabled: boolean;
  createdAt: Date;
  nextRunAt: Date;
  lastRunAt?: Date | null;
  lastStatus?: "ok" | "error" | "running" | null;
  lastResult?: string | null;
}

export type NewSchedule = {
  agentName: string;
  prompt: string;
  kind: ScheduleKind;
  intervalMinutes?: number;
  hourUtc?: number;
  minuteUtc?: number;
  enabled?: boolean;
};

export function computeNextRun(
  s: Pick<Schedule, "kind" | "intervalMinutes" | "hourUtc" | "minuteUtc">,
  from: Date = new Date(),
): Date {
  if (s.kind === "interval") {
    const mins = Math.max(1, s.intervalMinutes ?? 60);
    return new Date(from.getTime() + mins * 60_000);
  }
  const h = Math.min(23, Math.max(0, s.hourUtc ?? 9));
  const m = Math.min(59, Math.max(0, s.minuteUtc ?? 0));
  const next = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), h, m, 0, 0));
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export function describeSchedule(s: Schedule): string {
  if (s.kind === "interval") {
    const m = s.intervalMinutes ?? 60;
    if (m % 60 === 0) return `every ${m / 60}h`;
    return `every ${m}m`;
  }
  const hh = String(s.hourUtc ?? 9).padStart(2, "0");
  const mm = String(s.minuteUtc ?? 0).padStart(2, "0");
  return `daily at ${hh}:${mm} UTC`;
}

async function coll(): Promise<Collection<Schedule>> {
  return (await getDb()).collection<Schedule>("agent_schedules");
}

export const scheduleStore = {
  async create(s: NewSchedule): Promise<Schedule> {
    const now = new Date();
    const doc: Schedule = {
      _id: `sch_${randomUUID().slice(0, 12)}`,
      agentName: s.agentName,
      prompt: s.prompt,
      kind: s.kind,
      ...(s.intervalMinutes !== undefined ? { intervalMinutes: s.intervalMinutes } : {}),
      ...(s.hourUtc !== undefined ? { hourUtc: s.hourUtc } : {}),
      ...(s.minuteUtc !== undefined ? { minuteUtc: s.minuteUtc } : {}),
      enabled: s.enabled ?? true,
      createdAt: now,
      nextRunAt: computeNextRun(s, now),
      lastRunAt: null,
      lastStatus: null,
      lastResult: null,
    };
    await (await coll()).insertOne(doc);
    return doc;
  },

  async list(agentName?: string): Promise<Schedule[]> {
    const q = agentName ? { agentName } : {};
    return (await coll()).find(q).sort({ createdAt: -1 }).toArray();
  },

  async get(id: string): Promise<Schedule | null> {
    return (await coll()).findOne({ _id: id });
  },

  async update(id: string, fields: Partial<Schedule>): Promise<void> {
    await (await coll()).updateOne({ _id: id }, { $set: fields });
  },

  async delete(id: string): Promise<void> {
    await (await coll()).deleteOne({ _id: id });
  },

  async due(now: Date = new Date()): Promise<Schedule[]> {
    return (await coll()).find({ enabled: true, nextRunAt: { $lte: now } }).toArray();
  },
};
