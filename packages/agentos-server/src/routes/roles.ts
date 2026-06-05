// Roles admin — the editable role→permission map (Settings→Roles). All routes
// require `roles:manage`. `GET /permissions` exposes the code-defined catalog
// that drives the editor's checklist.

import { Router, type Router as IRouter } from "express";
import { roleStore, RoleValidationError } from "../stores/role-store.js";
import { PERMISSIONS } from "../auth/permissions.js";
import { authorize } from "../auth/authorize.js";
import { wrap } from "../http/async-handler.js";
import { badRequest, notFound, forbidden } from "../http/errors.js";

export const rolesRouter: IRouter = Router();

// The permission catalog (key + description) for the Roles editor checklist.
rolesRouter.get("/permissions", authorize("roles:manage"), (_req, res) => {
  res.json({ permissions: PERMISSIONS });
});

rolesRouter.get(
  "/roles",
  authorize("roles:manage"),
  wrap(async (_req, res) => {
    res.json({ roles: await roleStore.list() });
  }),
);

rolesRouter.post(
  "/roles",
  authorize("roles:manage"),
  wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b["name"] === "string" ? b["name"].trim() : "";
    if (!name) throw badRequest("MISSING_NAME", "`name` is required");
    const permissions = Array.isArray(b["permissions"]) ? (b["permissions"] as unknown[]).map(String) : [];
    const description = typeof b["description"] === "string" ? b["description"] : "";
    try {
      const role = await roleStore.create({ name, description, permissions });
      res.status(201).json({ role });
    } catch (err) {
      if (err instanceof RoleValidationError) throw badRequest("INVALID_ROLE", err.message);
      throw err;
    }
  }),
);

rolesRouter.put(
  "/roles/:id",
  authorize("roles:manage"),
  wrap(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const fields: { description?: string; permissions?: string[] } = {};
    if (typeof b["description"] === "string") fields.description = b["description"];
    if (Array.isArray(b["permissions"])) fields.permissions = (b["permissions"] as unknown[]).map(String);
    try {
      const role = await roleStore.update(req.params["id"]!, fields);
      if (!role) throw notFound();
      res.json({ role });
    } catch (err) {
      if (err instanceof RoleValidationError) throw badRequest("INVALID_ROLE", err.message);
      throw err;
    }
  }),
);

rolesRouter.delete(
  "/roles/:id",
  authorize("roles:manage"),
  wrap(async (req, res) => {
    const result = await roleStore.remove(req.params["id"]!);
    if (result === "not_found") throw notFound();
    if (result === "builtin") throw forbidden("BUILTIN_ROLE", "built-in roles cannot be deleted");
    res.json({ ok: true });
  }),
);
