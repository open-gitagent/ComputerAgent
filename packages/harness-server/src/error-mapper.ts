import type { Context, ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";

/**
 * Single error-to-HTTP mapper.
 *
 * Per project rules:
 *   - Validation returns Result<T, _> at module boundaries (not throws).
 *   - Inside the request lifecycle, throws are mapped here to typed HTTP responses.
 *   - Routes never write `try { ... } catch { c.json(...) }` themselves.
 *
 * Wired via `app.onError(...)` in `createHarnessServer`. This is the canonical Hono v4
 * pattern; do not change to a try/catch middleware (Hono's default error catcher
 * intercepts before user middleware can).
 */

/** Programmatic errors the routes throw — keep this list short and meaningful. */
export class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export const NotFound = (resource: string, id: string): ProtocolError =>
  new ProtocolError(404, "NOT_FOUND", `${resource} ${id} not found`);

export const BadRequest = (code: string, message: string, details?: unknown): ProtocolError =>
  new ProtocolError(400, code, message, details);

export const Conflict = (code: string, message: string): ProtocolError =>
  new ProtocolError(409, code, message);

export const onError: ErrorHandler = (err, c) => formatError(c, err);

function formatError(c: Context, err: unknown): Response {
  if (err instanceof ProtocolError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details } },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof HTTPException) {
    return c.json(
      { error: { code: "HTTP_EXCEPTION", message: err.message } },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: "VALIDATION", message: "Request body failed validation", details: err.issues } },
      400,
    );
  }
  const message = err instanceof Error ? err.message : "unknown error";
  return c.json({ error: { code: "INTERNAL", message } }, 500);
}
