import { z } from "zod";

/**
 * Centralized configuration for `@computeragent/observability`. Mirrors the
 * shape of Python TraceKit's `TracerConfig` so users coming from that surface
 * find a familiar API. Frozen at construction — pass a new config to change
 * behavior, never mutate.
 *
 * Defaults are tuned for production:
 *   - Content capture OFF (prompts/responses are PII — opt in explicitly).
 *   - Sample rate 1.0 (downstream collector handles sampling).
 *   - Metrics enabled (cheap, high signal).
 *
 * See PLAN.md / docs/observability.md for the rationale on each field.
 */

/** Built-in exporter names. "custom" means the user wires their own provider. */
export const ExporterType = z.enum([
  "console",
  "otlp-http",
  "otlp-grpc",
  "none",
  "custom",
]);
export type ExporterType = z.infer<typeof ExporterType>;

/**
 * Where to write `gen_ai.input.messages` / `gen_ai.output.messages` /
 * `gen_ai.system_instructions` when `captureContent` is enabled.
 *
 *   - `attributes`: write as JSON-string span attributes. Simple, works with
 *     any traces-only backend. Spec-discouraged for large payloads (size).
 *   - `events`: emit a `gen_ai.client.inference.operation.details` log event
 *     per assistant turn. Spec-preferred. Requires a logs exporter.
 *   - `both`: write to both during migrations.
 */
export const CaptureContentMode = z.enum(["attributes", "events", "both"]);
export type CaptureContentMode = z.infer<typeof CaptureContentMode>;

/**
 * TracerConfig — the single argument to `configure()`. Validated via Zod
 * (parse on construction, throw on bad input), then frozen.
 */
export const TracerConfigSchema = z
  .object({
    /** Service name on the OTel Resource. Shows up as `service.name`. */
    serviceName: z.string().min(1).default("computeragent"),

    /** Service version on the OTel Resource. Shows up as `service.version`. */
    serviceVersion: z.string().optional(),

    /** Deployment environment, e.g. "production", "staging". */
    deploymentEnvironment: z.string().optional(),

    /**
     * Exporter to register on the TracerProvider + MeterProvider. Use
     * `"custom"` if you call `configure()` with your own pre-built provider
     * (advanced usage); the package will then skip exporter registration.
     */
    exporter: ExporterType.default("console"),

    /** Endpoint for OTLP exporters. Required when exporter starts with "otlp-". */
    endpoint: z.string().url().optional(),

    /** Headers sent with every OTLP export (auth, tenant routing, etc.). */
    headers: z.record(z.string(), z.string()).optional(),

    /**
     * Trace head sample rate (0.0–1.0). Default 1.0 — defer sampling to a
     * collector or processor downstream where you have richer signal.
     */
    sampleRate: z.number().min(0).max(1).default(1.0),

    /**
     * Master switch for content capture (prompts, responses, tool args/results,
     * system instructions). Default OFF — these are PII-bearing.
     */
    captureContent: z.boolean().default(false),

    /**
     * Where captured content goes. Only meaningful when `captureContent: true`.
     * Default `"events"` — spec-preferred and decouples high-volume content
     * from span exporters.
     */
    captureContentMode: CaptureContentMode.default("events"),

    /** Truncation cap for any single string attribute, in bytes. */
    maxAttributeLength: z.number().int().positive().default(4096),

    /** Whether to register a MeterProvider and emit `gen_ai.client.*` histograms. */
    metricsEnabled: z.boolean().default(true),

    /** Override the traces OTLP endpoint. Defaults to `endpoint` + `/v1/traces`. */
    tracesEndpoint: z.string().url().optional(),

    /** Override the metrics OTLP endpoint. Defaults to `endpoint` + `/v1/metrics`. */
    metricsEndpoint: z.string().url().optional(),

    /** Periodic metrics export interval (ms). */
    metricsExportIntervalMillis: z.number().int().positive().default(60_000),

    /** Override the logs OTLP endpoint. Defaults to `endpoint` + `/v1/logs`. */
    logsEndpoint: z.string().url().optional(),

    /** Extra resource attributes merged onto the default Resource. */
    resourceAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),

    /**
     * Opt-in PII redaction backstop. Runs on captured content attributes
     * before they're written to the span/event. Default OFF until the
     * pattern set has soaked.
     */
    redaction: z
      .object({
        enabled: z.boolean().default(false),
        replacement: z.string().default("[REDACTED:{kind}]"),
      })
      .default({ enabled: false, replacement: "[REDACTED:{kind}]" }),
  })
  .superRefine((cfg, ctx) => {
    if ((cfg.exporter === "otlp-http" || cfg.exporter === "otlp-grpc") && !cfg.endpoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endpoint"],
        message: `endpoint is required when exporter='${cfg.exporter}'`,
      });
    }
  });

export type TracerConfigInput = z.input<typeof TracerConfigSchema>;
export type TracerConfig = z.output<typeof TracerConfigSchema>;

/**
 * Validate, normalize, and freeze a config. Throws ZodError on bad input.
 * Returns a deep-frozen object — mutations on it are TypeError at runtime in
 * strict mode.
 */
export function parseTracerConfig(input: TracerConfigInput = {}): TracerConfig {
  const parsed = TracerConfigSchema.parse(input);
  return deepFreeze(parsed);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v);
  }
  return value;
}
