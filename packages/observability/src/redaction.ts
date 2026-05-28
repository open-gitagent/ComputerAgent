/**
 * Opt-in PII redaction backstop. Ported from TraceKit's pattern set with the
 * regex syntax adjusted for ECMAScript (vs Python RE2). Off by default —
 * enable via `configure({ redaction: { enabled: true } })`.
 *
 * Patterns target high-confidence, low-false-positive matches: things that
 * are almost never legitimate prompt content (API keys, JWTs, AWS access
 * keys, GitHub tokens) and the most common direct identifiers (email,
 * credit card numbers). We deliberately skip phone / SSN / IP for now —
 * they collide too often with model-generated numbers.
 *
 * Each match is replaced with `replacement.replace("{kind}", PATTERN_NAME)`,
 * e.g. `"[REDACTED:EMAIL]"`.
 */

interface NamedPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/**
 * Order matters: alternatives matching at the same position resolve
 * leftmost-first. Put token-shaped patterns BEFORE generic ones so a
 * GitHub PAT doesn't get classified as a generic api key (and vice versa).
 */
const BUILTIN_PATTERNS: ReadonlyArray<NamedPattern> = [
  // JWT first — exact shape, never a false positive.
  { name: "JWT", pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },

  // AWS access keys — prefix + 16 hex/upper.
  { name: "AWS_ACCESS_KEY", pattern: /(?:AKIA|ASIA|AGPA|AROA|AIDA|ANPA|ANVA|APKA)[A-Z0-9]{16}/g },

  // GitHub tokens — clear prefix.
  { name: "GITHUB_TOKEN", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },

  // Anthropic / OpenAI / generic sk- prefixed keys.
  { name: "API_KEY", pattern: /sk-(?:ant-)?[A-Za-z0-9_-]{20,}/g },

  // Email — RFC-ish but conservative.
  { name: "EMAIL", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },

  // Credit cards (Luhn-style 13-19 digits with optional separators).
  { name: "CREDIT_CARD", pattern: /\b(?:\d[ -]?){13,19}\b/g },
];

/**
 * Apply every enabled pattern to `text` and return the redacted string.
 * Replacement template substitutes `{kind}` with the upper-case pattern
 * name (e.g. `"[REDACTED:EMAIL]"`). When no patterns match, the input is
 * returned unchanged.
 */
export function applyRedaction(text: string, replacement: string): string {
  let out = text;
  for (const { name, pattern } of BUILTIN_PATTERNS) {
    // Recreate the regex per call so we don't share state with concurrent
    // callers (RegExp objects with /g carry lastIndex).
    const re = new RegExp(pattern.source, pattern.flags);
    out = out.replace(re, replacement.replace("{kind}", name));
  }
  return out;
}

/** Names of built-in patterns — exposed for the conformance suite. */
export function builtinPatternNames(): string[] {
  return BUILTIN_PATTERNS.map((p) => p.name);
}
