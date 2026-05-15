/**
 * Typed errors the SDK throws when the harness returns a structured 4xx body.
 *
 * The wire shape from the harness (`error-mapper.ts`) is always:
 *   { error: { code: string; message: string; details?: unknown } }
 *
 * The SDK parses that into one of the subclasses below so callers can do
 * `catch (e) { if (e instanceof UnknownEngineError) { ... e.available ... } }`
 * instead of string-matching on a generic `Error.message`.
 *
 * Subclasses correspond 1:1 to the codes the harness emits today
 * (`UNKNOWN_ENGINE`, `UNKNOWN_LOADER`, `UNKNOWN_STORE`). Any other code falls
 * back to the base `HarnessProtocolError` so callers can still inspect `code`.
 */

/** Wire-side error envelope. Internal. */
interface WireErrorBody {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
    readonly details?: unknown;
  };
}

/**
 * Base class for every error the SDK throws when the harness responds with a
 * structured 4xx body. Callers usually catch a specific subclass; this exists
 * for codes we don't have a subclass for yet.
 */
export class HarnessProtocolError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(args: { status: number; code: string; message: string; details?: unknown }) {
    super(args.message);
    this.name = "HarnessProtocolError";
    this.code = args.code;
    this.status = args.status;
    this.details = args.details;
  }
}

/** Engine name in `harness:` not registered on the server. */
export class UnknownEngineError extends HarnessProtocolError {
  /** Engines the server actually has registered, echoed from `details.available`. */
  readonly available: readonly string[];
  /** The unrecognized name the caller passed. */
  readonly requested: string;

  constructor(args: { status: number; message: string; requested: string; available: readonly string[] }) {
    const hint = suggestNearest(args.requested, args.available);
    const formatted =
      `${args.message}. Available: ${args.available.join(", ") || "(none)"}` +
      (hint ? `. Did you mean "${hint}"?` : "");
    super({ status: args.status, code: "UNKNOWN_ENGINE", message: formatted, details: { available: args.available, requested: args.requested } });
    this.name = "UnknownEngineError";
    this.available = args.available;
    this.requested = args.requested;
  }
}

/** Identity loader name in `identityLoader:` not registered on the server. */
export class UnknownLoaderError extends HarnessProtocolError {
  readonly available: readonly string[];
  readonly requested: string;

  constructor(args: { status: number; message: string; requested: string; available: readonly string[] }) {
    const hint = suggestNearest(args.requested, args.available);
    const formatted =
      `${args.message}. Available: ${args.available.join(", ") || "(none)"}` +
      (hint ? `. Did you mean "${hint}"?` : "");
    super({ status: args.status, code: "UNKNOWN_LOADER", message: formatted, details: { available: args.available, requested: args.requested } });
    this.name = "UnknownLoaderError";
    this.available = args.available;
    this.requested = args.requested;
  }
}

/** Session-store `kind` not registered on the server. */
export class UnknownStoreError extends HarnessProtocolError {
  readonly available: readonly string[];
  readonly requested: string;

  constructor(args: { status: number; message: string; requested: string; available: readonly string[] }) {
    const hint = suggestNearest(args.requested, args.available);
    const formatted =
      `${args.message}. Available: ${args.available.join(", ") || "(none)"}` +
      (hint ? `. Did you mean "${hint}"?` : "");
    super({ status: args.status, code: "UNKNOWN_STORE", message: formatted, details: { available: args.available, requested: args.requested } });
    this.name = "UnknownStoreError";
    this.available = args.available;
    this.requested = args.requested;
  }
}

/**
 * Parse a non-OK Response from the harness. On a structured error body, return
 * a typed `HarnessProtocolError` subclass; otherwise fall back to a generic
 * Error with the raw body for diagnostics.
 *
 * Used by the SDK at every harness call site that previously threw a generic
 * `new Error("POST ... failed: 400 ...")`. Centralized so every endpoint
 * benefits from the same parsing logic.
 */
export async function asHarnessError(res: Response, requestedHints: {
  engine?: string;
  loader?: string;
  storeKind?: string;
} = {}): Promise<Error> {
  const text = await res.text();
  let body: WireErrorBody | undefined;
  try {
    body = JSON.parse(text) as WireErrorBody;
  } catch {
    return new Error(`Harness request failed: ${res.status} ${text.slice(0, 500)}`);
  }
  const err = body?.error;
  const code = typeof err?.code === "string" ? err.code : undefined;
  const message = typeof err?.message === "string" ? err.message : `Harness ${res.status}`;
  const details = err?.details;

  const available = extractAvailable(details);

  if (code === "UNKNOWN_ENGINE" && requestedHints.engine !== undefined) {
    return new UnknownEngineError({ status: res.status, message, requested: requestedHints.engine, available });
  }
  if (code === "UNKNOWN_LOADER" && requestedHints.loader !== undefined) {
    return new UnknownLoaderError({ status: res.status, message, requested: requestedHints.loader, available });
  }
  if (code === "UNKNOWN_STORE" && requestedHints.storeKind !== undefined) {
    return new UnknownStoreError({ status: res.status, message, requested: requestedHints.storeKind, available });
  }
  if (code) {
    return new HarnessProtocolError({ status: res.status, code, message, details });
  }
  return new Error(`Harness request failed: ${res.status} ${text.slice(0, 500)}`);
}

function extractAvailable(details: unknown): readonly string[] {
  if (!details || typeof details !== "object") return [];
  const av = (details as { available?: unknown }).available;
  if (!Array.isArray(av)) return [];
  return av.filter((x): x is string => typeof x === "string");
}

/**
 * Closest match in `candidates` to `input` by simple edit distance. Returns
 * the candidate if it's within a sensible distance (≤ ⅓ of input length, min 2);
 * undefined otherwise so we don't suggest wildly unrelated names.
 *
 * Intentionally tiny — no fuzzy library, no Levenshtein optimization, just
 * the standard DP. Inputs are short (< 30 chars) so the O(n*m) cost is fine.
 */
function suggestNearest(input: string, candidates: readonly string[]): string | undefined {
  if (candidates.length === 0) return undefined;
  let best: { name: string; dist: number } | undefined;
  for (const c of candidates) {
    const d = editDistance(input, c);
    if (!best || d < best.dist) best = { name: c, dist: d };
  }
  if (!best) return undefined;
  const threshold = Math.max(2, Math.floor(input.length / 3));
  return best.dist <= threshold ? best.name : undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length;
  const n = b.length;
  // Single-row DP — we only need the previous row at any time.
  let prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  let curr: number[] = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1]! + 1,         // insertion
        prev[j]! + 1,             // deletion
        prev[j - 1]! + cost,      // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
