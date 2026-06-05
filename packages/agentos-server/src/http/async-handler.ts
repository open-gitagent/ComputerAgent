// `wrap` adapts an async handler so a rejected promise routes to Express's
// error pipeline (next(err)) instead of crashing the process. Replaces the
// repeated `try { ... } catch (err) { next(err); }` boilerplate in handlers.

import type { Request, Response, NextFunction, RequestHandler } from "express";

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
