// Typed HTTP errors + the standard error envelope. Handlers can `throw
// badRequest("MISSING_LABEL")` (or any helper) and the central errorHandler
// renders `{ error: { code, message, details? } }` with the right status.

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code = "BAD_REQUEST", message?: string, details?: unknown) =>
  new ApiError(400, code, message, details);
export const unauthorized = (code = "UNAUTHENTICATED", message?: string) =>
  new ApiError(401, code, message);
export const forbidden = (code = "FORBIDDEN", message?: string) =>
  new ApiError(403, code, message);
export const notFound = (code = "NOT_FOUND", message?: string) =>
  new ApiError(404, code, message);
export const serviceUnavailable = (code = "UNAVAILABLE", message?: string) =>
  new ApiError(503, code, message);
