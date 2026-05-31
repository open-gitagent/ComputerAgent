import { trace, metrics, type Tracer, type Meter } from "@opentelemetry/api";
import { logs, type Logger as OtelLogger } from "@opentelemetry/api-logs";
import { Resource } from "@opentelemetry/resources";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-node";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  View,
  ExplicitBucketHistogramAggregation,
  ConsoleMetricExporter,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions";
import { parseTracerConfig, type TracerConfig, type TracerConfigInput } from "./config.js";
import {
  INSTRUMENTATION_SCOPE_NAME,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK,
  METRIC_GEN_AI_CLIENT_TIME_PER_OUTPUT_CHUNK,
  METRIC_COMPUTERAGENT_USAGE_COST_USD,
  TOKEN_USAGE_BUCKETS,
  OPERATION_DURATION_BUCKETS,
  COST_USD_BUCKETS,
} from "./semantic/attributes.js";

/**
 * `configure()` / `shutdown()` — the lifecycle endpoints for the observability
 * layer. Boots a NodeTracerProvider + MeterProvider (+ LoggerProvider when
 * content events are enabled), registers them as globals, and installs Views
 * that pin the spec's exact histogram bucket boundaries onto every
 * `gen_ai.client.*` metric.
 *
 * Idempotent: calling `configure` twice is a no-op the second time. Call
 * `shutdown` first if you need to swap exporters at runtime.
 */

interface Installed {
  readonly config: TracerConfig;
  readonly tracerProvider: NodeTracerProvider;
  readonly meterProvider: MeterProvider;
  readonly loggerProvider?: LoggerProvider;
}

let installed: Installed | undefined;

/**
 * Boot the OpenTelemetry pipeline using the supplied config. Returns the
 * frozen, fully-resolved config that was applied. Idempotent.
 */
export function configure(input: TracerConfigInput = {}): TracerConfig {
  if (installed) return installed.config;

  const config = parseTracerConfig(input);
  const resource = buildResource(config);

  const tracerProvider = buildTracerProvider(config, resource);
  tracerProvider.register();

  const meterProvider = buildMeterProvider(config, resource);
  metrics.setGlobalMeterProvider(meterProvider);

  let loggerProvider: LoggerProvider | undefined;
  if (needsLoggerProvider(config)) {
    loggerProvider = buildLoggerProvider(config, resource);
    logs.setGlobalLoggerProvider(loggerProvider);
  }

  installed = { config, tracerProvider, meterProvider, loggerProvider };
  return config;
}

/**
 * Flush exporters and tear down the registered providers. Safe to call when
 * nothing is configured (no-op). Returns once all three pipelines have shut
 * down or after the timeout (ms) elapses.
 */
export async function shutdown(timeoutMs = 5_000): Promise<void> {
  if (!installed) return;
  const { tracerProvider, meterProvider, loggerProvider } = installed;
  installed = undefined;

  const withTimeout = <T>(p: Promise<T>): Promise<T | undefined> =>
    Promise.race([p, new Promise<undefined>((res) => setTimeout(() => res(undefined), timeoutMs))]);

  await Promise.allSettled([
    withTimeout(tracerProvider.shutdown()),
    withTimeout(meterProvider.shutdown()),
    loggerProvider ? withTimeout(loggerProvider.shutdown()) : Promise.resolve(undefined),
  ]);
}

/**
 * Resolved config — useful for downstream modules that need to know whether
 * content capture is on, what the redaction policy is, etc. Returns
 * `undefined` when nothing has been configured yet.
 */
export function getConfig(): TracerConfig | undefined {
  return installed?.config;
}

/** Get the Tracer used by this package's instrumentation scope. */
export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_SCOPE_NAME, "0.1.0");
}

/** Get the Meter used by this package's instrumentation scope. */
export function getMeter(): Meter {
  return metrics.getMeter(INSTRUMENTATION_SCOPE_NAME, "0.1.0");
}

/** Get the Logger used by this package's instrumentation scope. */
export function getLogger(): OtelLogger {
  return logs.getLogger(INSTRUMENTATION_SCOPE_NAME, "0.1.0");
}

// ---------------------------------------------------------------------------
// Internal builders
// ---------------------------------------------------------------------------

function buildResource(config: TracerConfig): Resource {
  const attrs: Record<string, string | number | boolean> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
  };
  if (config.serviceVersion) attrs[ATTR_SERVICE_VERSION] = config.serviceVersion;
  if (config.deploymentEnvironment) attrs[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = config.deploymentEnvironment;
  if (config.resourceAttributes) Object.assign(attrs, config.resourceAttributes);
  return Resource.default().merge(new Resource(attrs));
}

function buildTracerProvider(config: TracerConfig, resource: Resource): NodeTracerProvider {
  const sampler = new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(config.sampleRate),
  });
  const provider = new NodeTracerProvider({ resource, sampler });
  const exporter = buildSpanExporter(config);
  if (exporter) provider.addSpanProcessor(new BatchSpanProcessor(exporter));
  return provider;
}

function buildMeterProvider(config: TracerConfig, resource: Resource): MeterProvider {
  // Spec-exact histogram bucket boundaries. Registered as Views matched by
  // metric name so any code path emitting these histograms picks up the
  // right aggregation — the SDK's default ExponentialHistogram would not
  // satisfy backends that expect the spec's explicit buckets.
  const views: View[] = [
    new View({
      instrumentName: METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
      aggregation: new ExplicitBucketHistogramAggregation([...TOKEN_USAGE_BUCKETS]),
    }),
    new View({
      instrumentName: METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
      aggregation: new ExplicitBucketHistogramAggregation([...OPERATION_DURATION_BUCKETS]),
    }),
    new View({
      instrumentName: METRIC_GEN_AI_CLIENT_TIME_TO_FIRST_CHUNK,
      aggregation: new ExplicitBucketHistogramAggregation([...OPERATION_DURATION_BUCKETS]),
    }),
    new View({
      instrumentName: METRIC_GEN_AI_CLIENT_TIME_PER_OUTPUT_CHUNK,
      aggregation: new ExplicitBucketHistogramAggregation([...OPERATION_DURATION_BUCKETS]),
    }),
    // computeragent.* metric — NOT spec-defined, but the SDK's default
    // histogram buckets (0, 5, 10, 25, ...) are wildly wrong for USD cost
    // values that typically sit between $0.0001 and $50.
    new View({
      instrumentName: METRIC_COMPUTERAGENT_USAGE_COST_USD,
      aggregation: new ExplicitBucketHistogramAggregation([...COST_USD_BUCKETS]),
    }),
  ];

  const provider = new MeterProvider({ resource, views });
  if (!config.metricsEnabled) return provider;

  const exporter = buildMetricExporter(config);
  if (exporter) {
    provider.addMetricReader(
      new PeriodicExportingMetricReader({
        exporter,
        exportIntervalMillis: config.metricsExportIntervalMillis,
      }),
    );
  }
  return provider;
}

function buildLoggerProvider(config: TracerConfig, resource: Resource): LoggerProvider {
  const provider = new LoggerProvider({ resource });
  const exporter = buildLogExporter(config);
  if (exporter) provider.addLogRecordProcessor(new BatchLogRecordProcessor(exporter));
  return provider;
}

function needsLoggerProvider(config: TracerConfig): boolean {
  return (
    config.captureContent && (config.captureContentMode === "events" || config.captureContentMode === "both")
  );
}

function buildSpanExporter(config: TracerConfig): SpanExporter | undefined {
  switch (config.exporter) {
    case "console":
      return new ConsoleSpanExporter();
    case "otlp-http":
      return new OTLPTraceExporter({
        url: config.tracesEndpoint ?? deriveTracesUrl(config.endpoint),
        headers: config.headers,
      });
    case "otlp-grpc":
      throw new Error(
        "exporter='otlp-grpc' is not bundled — install @opentelemetry/exporter-trace-otlp-grpc and use exporter='custom' with your own provider.",
      );
    case "none":
    case "custom":
    default:
      return undefined;
  }
}

function buildMetricExporter(config: TracerConfig): PushMetricExporter | undefined {
  switch (config.exporter) {
    case "console":
      return new ConsoleMetricExporter();
    case "otlp-http":
      return new OTLPMetricExporter({
        url: config.metricsEndpoint ?? deriveMetricsUrl(config.endpoint),
        headers: config.headers,
      });
    case "otlp-grpc":
      throw new Error(
        "exporter='otlp-grpc' is not bundled for metrics — install the gRPC exporter and use exporter='custom'.",
      );
    case "none":
    case "custom":
    default:
      return undefined;
  }
}

function buildLogExporter(config: TracerConfig): LogRecordExporter | undefined {
  switch (config.exporter) {
    case "console":
      return new ConsoleLogRecordExporter();
    case "otlp-http":
      return new OTLPLogExporter({
        url: config.logsEndpoint ?? deriveLogsUrl(config.endpoint),
        headers: config.headers,
      });
    case "otlp-grpc":
      throw new Error(
        "exporter='otlp-grpc' is not bundled for logs — install the gRPC exporter and use exporter='custom'.",
      );
    case "none":
    case "custom":
    default:
      return undefined;
  }
}

function deriveTracesUrl(endpoint: string | undefined): string | undefined {
  return rebaseOtlpPath(endpoint, "/v1/traces");
}

function deriveMetricsUrl(endpoint: string | undefined): string | undefined {
  return rebaseOtlpPath(endpoint, "/v1/metrics");
}

function deriveLogsUrl(endpoint: string | undefined): string | undefined {
  return rebaseOtlpPath(endpoint, "/v1/logs");
}

/**
 * Rebases an OTLP endpoint URL to a sibling signal path.
 *
 * Users typically pass a collector base ("https://otel.example/") OR a full
 * traces path ("https://otel.example/v1/traces"). We support both:
 *   - "https://otel.example/"           + "/v1/metrics" -> "https://otel.example/v1/metrics"
 *   - "https://otel.example/v1/traces"  + "/v1/metrics" -> "https://otel.example/v1/metrics"
 */
function rebaseOtlpPath(endpoint: string | undefined, signalPath: string): string | undefined {
  if (!endpoint) return undefined;
  // Strip a trailing /v1/<signal> if present.
  const withoutSignal = endpoint.replace(/\/v1\/(traces|metrics|logs)\/?$/, "");
  const base = withoutSignal.replace(/\/$/, "");
  return `${base}${signalPath}`;
}
