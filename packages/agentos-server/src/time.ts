// Accepts ISO 8601 ("2026-05-28T00:00:00Z") or relative ("now", "now-1h",
// "now-24h", "now-7d", "now-30s"). Returns a Date in UTC.
export function parseTime(input: string): Date {
  if (input.startsWith("now")) {
    if (input === "now") return new Date();
    const m = input.match(/^now-(\d+)([smhd])$/);
    if (!m) throw new BadTimeError(input);
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    const ms = unit === "s" ? n * 1000 : unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(Date.now() - ms);
  }
  const d = new Date(input);
  if (isNaN(d.getTime())) throw new BadTimeError(input);
  return d;
}

export function toClickHouseDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

export class BadTimeError extends Error {
  status = 400;
  constructor(input: string) {
    super(`bad time value: ${JSON.stringify(input)} (expected ISO 8601 or "now-1h" / "now-24h" / "now-7d")`);
  }
}
