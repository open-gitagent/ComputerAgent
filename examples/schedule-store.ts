/**
 * ScheduleStore — agent run schedules, in MongoDB (`agent_schedules`).
 *
 * Each schedule fires a one-shot agent run (a prompt against an agent) on a
 * cadence: either a fixed interval (every N minutes) or daily at a UTC time.
 * The scheduler tick (see scheduler.ts) reads due schedules and runs them.
 */
import { MongoClient, type Collection } from "mongodb";
import { randomUUID } from "node:crypto";

export type ScheduleKind = "interval" | "daily";

export interface Schedule {
  _id: string;
  agentName: string;          // which agent (type) to run
  prompt: string;             // the message to send
  kind: ScheduleKind;
  intervalMinutes?: number;   // kind=interval
  hourUtc?: number;           // kind=daily (0-23, UTC)
  minuteUtc?: number;         // kind=daily (0-59)
  enabled: boolean;
  createdAt: Date;
  nextRunAt: Date;
  lastRunAt?: Date | null;
  lastStatus?: "ok" | "error" | "running" | null;
  lastResult?: string | null; // truncated final text or error
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

/** Next fire time at/after `from` for a schedule spec. */
export function computeNextRun(s: Pick<Schedule, "kind" | "intervalMinutes" | "hourUtc" | "minuteUtc">, from: Date = new Date()): Date {
  if (s.kind === "interval") {
    const mins = Math.max(1, s.intervalMinutes ?? 60);
    return new Date(from.getTime() + mins * 60_000);
  }
  // daily at HH:MM UTC — next occurrence strictly after `from`
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

export class ScheduleStore {
  private readonly client: MongoClient;
  private readonly dbName: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor(url: string, dbName: string) {
    this.client = new MongoClient(url);
    this.dbName = dbName;
  }

  private async coll(): Promise<Collection<Schedule>> {
    if (!this.connected) {
      if (!this.connectPromise) this.connectPromise = this.client.connect().then(() => { this.connected = true; });
      await this.connectPromise;
    }
    return this.client.db(this.dbName).collection<Schedule>("agent_schedules");
  }

  async create(s: NewSchedule): Promise<Schedule> {
    const now = new Date();
    const doc: Schedule = {
      _id: `sch_${randomUUID().slice(0, 12)}`,
      agentName: s.agentName,
      prompt: s.prompt,
      kind: s.kind,
      intervalMinutes: s.intervalMinutes,
      hourUtc: s.hourUtc,
      minuteUtc: s.minuteUtc,
      enabled: s.enabled ?? true,
      createdAt: now,
      nextRunAt: computeNextRun(s, now),
      lastRunAt: null,
      lastStatus: null,
      lastResult: null,
    };
    await (await this.coll()).insertOne(doc);
    return doc;
  }

  async list(agentName?: string): Promise<Schedule[]> {
    const q = agentName ? { agentName } : {};
    return (await this.coll()).find(q).sort({ createdAt: -1 }).toArray();
  }

  async get(id: string): Promise<Schedule | null> {
    return (await this.coll()).findOne({ _id: id });
  }

  async update(id: string, fields: Partial<Schedule>): Promise<void> {
    await (await this.coll()).updateOne({ _id: id }, { $set: fields });
  }

  async delete(id: string): Promise<void> {
    await (await this.coll()).deleteOne({ _id: id });
  }

  /** Enabled schedules whose nextRunAt has passed. */
  async due(now: Date = new Date()): Promise<Schedule[]> {
    return (await this.coll()).find({ enabled: true, nextRunAt: { $lte: now } }).toArray();
  }
}
