import { Router, type Router as IRouter } from "express";
import { FIELDS } from "../fields.js";

export const fieldsRouter: IRouter = Router();

// Optional discovery endpoint. The UI mirrors fields.ts locally (obs-fields.ts)
// for zero-roundtrip, but this is handy for testing / external clients.
fieldsRouter.get("/fields", (_req, res) => {
  res.json({
    fields: Object.values(FIELDS).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      ops: f.ops,
      enumValues: f.enumValues,
    })),
  });
});
