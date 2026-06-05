// Central error handler — the single place that renders the error envelope.
// Standardizes on `{ error: { code, message, details? } }` for every status
// (the previous inline handler emitted a bare `{ error: "string" }` on 500s).
// Success bodies are untouched — only error shapes are normalized here.

import type { ErrorRequestHandler } from "express";
import { ApiError } from "./errors.js";

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status =
    err instanceof ApiError ? err.status : typeof err?.status === "number" ? err.status : 500;
  const code =
    err instanceof ApiError
      ? err.code
      : typeof err?.code === "string"
        ? err.code
        : status >= 500
          ? "INTERNAL"
          : "ERROR";
  const message = typeof err?.message === "string" ? err.message : "internal error";
  const details = err instanceof ApiError ? err.details : undefined;
  if (status >= 500) console.error("[agentos-server]", err);
  res.status(status).json({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
};
