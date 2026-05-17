/**
 * Tiny structured logger — stderr only, JSON-line or pretty.
 *
 * Why not pino? Bundle weight. The harness bundle ships into substrates;
 * 80 LOC of zero-dep TS is preferable to pulling pino's transports tree.
 * The `Logger` interface is stable, so swapping the implementation is
 * trivial later.
 *
 * Configuration:
 *   COMPUTERAGENT_LOG=debug|info|warn|error|silent  (default: info)
 *   COMPUTERAGENT_LOG_FORMAT=pretty|json            (default: pretty if stderr is TTY, else json)
 *
 * Conventions:
 *   - First argument is a dotted event name: `engine.turn.start`, `substrate.boot`
 *   - Second argument is a flat object of fields
 *   - Components prefix their events: `engine.*`, `harness.*`, `substrate.*`, `client.*`
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 99,
};

export interface CreateLoggerOptions {
  readonly component?: string;
  readonly level?: LogLevel;
  readonly format?: "pretty" | "json";
}

export function createLogger(opts: CreateLoggerOptions = {}): Logger {
  const level = opts.level ?? resolveLevelFromEnv() ?? "info";
  const minOrder = LEVEL_ORDER[level];
  const format = opts.format ?? resolveFormatFromEnv() ?? defaultFormat();
  const component = opts.component;

  const emit = (lvl: Exclude<LogLevel, "silent">, event: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[lvl] < minOrder) return;
    const line = format === "json" ? formatJson(lvl, event, component, fields) : formatPretty(lvl, event, component, fields);
    try {
      process.stderr.write(line + "\n");
    } catch {
      // stderr write failed (closed FD, etc.) — swallow; logging must never throw.
    }
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, fields) => emit("error", event, fields),
  };
}

export const nopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function resolveLevelFromEnv(): LogLevel | undefined {
  const raw = (typeof process !== "undefined" ? process.env.COMPUTERAGENT_LOG : undefined)?.toLowerCase();
  if (raw && raw in LEVEL_ORDER) return raw as LogLevel;
  return undefined;
}

function resolveFormatFromEnv(): "pretty" | "json" | undefined {
  const raw = (typeof process !== "undefined" ? process.env.COMPUTERAGENT_LOG_FORMAT : undefined)?.toLowerCase();
  if (raw === "pretty" || raw === "json") return raw;
  return undefined;
}

function defaultFormat(): "pretty" | "json" {
  if (typeof process === "undefined" || !process.stderr) return "json";
  // process.stderr.isTTY is true when attached to an interactive terminal.
  return process.stderr.isTTY ? "pretty" : "json";
}

function formatJson(level: string, event: string, component: string | undefined, fields: Record<string, unknown> | undefined): string {
  const payload: Record<string, unknown> = { t: new Date().toISOString(), level, event };
  if (component) payload.component = component;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) payload[k] = serializableValue(v);
    }
  }
  return JSON.stringify(payload);
}

function formatPretty(level: string, event: string, component: string | undefined, fields: Record<string, unknown> | undefined): string {
  const now = new Date();
  const stamp =
    String(now.getHours()).padStart(2, "0") +
    ":" +
    String(now.getMinutes()).padStart(2, "0") +
    ":" +
    String(now.getSeconds()).padStart(2, "0") +
    "." +
    String(now.getMilliseconds()).padStart(3, "0");
  const lvl = LEVEL_LABEL[level as keyof typeof LEVEL_LABEL] ?? level.toUpperCase().padEnd(5);
  const head = component ? `${component}.${event}` : event;
  const tail = fields ? formatFields(fields) : "";
  return `[${stamp}] ${lvl} ${head}${tail ? "  " + tail : ""}`;
}

const LEVEL_LABEL = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

function formatFields(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v.includes(" ") ? JSON.stringify(v) : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function serializableValue(v: unknown): unknown {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Error) return { message: v.message, name: v.name };
  try {
    JSON.stringify(v);
    return v;
  } catch {
    return String(v);
  }
}
