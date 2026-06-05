// Groups — read-only window into the Keycloak realm's groups (Okta/Keycloak own
// groups + membership; AgentOS never writes them). Gated by `groups:read`.
// Degrades gracefully (503) when the admin client isn't configured.

import { Router, type Router as IRouter } from "express";
import { authorize } from "../auth/authorize.js";
import { wrap } from "../http/async-handler.js";
import { serviceUnavailable } from "../http/errors.js";
import {
  keycloakAdminConfigured,
  listGroups,
  listGroupMembers,
  listUserRealmRoles,
  KeycloakAdminError,
} from "../auth/keycloak-admin.js";

export const groupsRouter: IRouter = Router();

const MEMBERS_CAP = 50;

function requireConfigured(): void {
  if (!keycloakAdminConfigured()) {
    throw serviceUnavailable(
      "KEYCLOAK_ADMIN_NOT_CONFIGURED",
      "Keycloak admin client is not configured (set the admin client + grant it view-realm).",
    );
  }
}

// GET /groups → realm groups (read-only).
groupsRouter.get(
  "/groups",
  authorize("groups:read"),
  wrap(async (_req, res) => {
    requireConfigured();
    try {
      const groups = await listGroups();
      res.json({ groups: groups.map((g) => ({ id: g.id, name: g.name, path: g.path })) });
    } catch (err) {
      if (err instanceof KeycloakAdminError) throw serviceUnavailable("KEYCLOAK_ADMIN_ERROR", err.message);
      throw err;
    }
  }),
);

// GET /groups/:id/members → members + their realm roles (shows that a single
// group can contain users with different roles). Capped + flagged when truncated.
groupsRouter.get(
  "/groups/:id/members",
  authorize("groups:read"),
  wrap(async (req, res) => {
    requireConfigured();
    try {
      const members = await listGroupMembers(req.params["id"]!, MEMBERS_CAP + 1);
      const shown = members.slice(0, MEMBERS_CAP);
      const withRoles = await Promise.all(
        shown.map(async (m) => ({
          id: m.id,
          username: m.username ?? null,
          email: m.email ?? null,
          name: [m.firstName, m.lastName].filter(Boolean).join(" ") || null,
          roles: await listUserRealmRoles(m.id).catch(() => [] as string[]),
        })),
      );
      res.json({ members: withRoles, truncated: members.length > MEMBERS_CAP });
    } catch (err) {
      if (err instanceof KeycloakAdminError) throw serviceUnavailable("KEYCLOAK_ADMIN_ERROR", err.message);
      throw err;
    }
  }),
);
