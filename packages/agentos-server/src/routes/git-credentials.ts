// Git credentials (PATs) — create / list / delete (dashboard) + resolve (SDK).
//
// A credential is owned by a GROUP (tenancy) and scoped to one HOST. The secret
// is AES-256-GCM encrypted at rest and only ever decrypted on `/resolve`, after
// RBAC + group-ownership checks.
//
//   POST   /git-credentials          git-credentials:manage   create/rotate
//   GET    /git-credentials          git-credentials:read     list (redacted)
//   DELETE /git-credentials/:id      git-credentials:manage   delete (owner/admin)
//   POST   /git-credentials/resolve  git-credentials:read     SDK: fetch the PAT
//
// The resolve route is what the Python SDK calls with its `cak_` key — it works
// because cak_ keys authenticate at the dashboard boundary and yield a service
// principal whose `groups = [key.group]`.

import { Router, type Router as IRouter } from "express";
import { gitCredentialStore, normalizeGitHost } from "../stores/git-credential-store.js";
import { credentialsKeyConfigured } from "../crypto/secret-box.js";
import { authorize } from "../auth/authorize.js";
import { canRead, canWrite, pickOwnerGroup } from "../auth/ownership.js";

export const gitCredentialsRouter: IRouter = Router();

const DEFAULT_USERNAME = "x-access-token";

// POST /git-credentials  { host, group?, label, token, username? } → 201 { credential }
gitCredentialsRouter.post("/git-credentials", authorize("git-credentials:manage"), async (req, res, next) => {
  try {
    if (!credentialsKeyConfigured()) {
      return res.status(503).json({ error: { code: "CREDENTIALS_KEY_NOT_CONFIGURED", message: "AGENTOS_CREDENTIALS_KEY is not set" } });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const host = typeof b["host"] === "string" ? normalizeGitHost(b["host"]) : "";
    const label = typeof b["label"] === "string" ? b["label"].trim() : "";
    const token = typeof b["token"] === "string" ? b["token"].trim() : "";
    const username = typeof b["username"] === "string" && b["username"].trim() ? b["username"].trim() : null;
    if (!host) return res.status(400).json({ error: { code: "MISSING_HOST" } });
    if (!label) return res.status(400).json({ error: { code: "MISSING_LABEL" } });
    if (!token) return res.status(400).json({ error: { code: "MISSING_TOKEN" } });

    const principal = res.locals.principal!;
    // A PAT is always group-owned. pickOwnerGroup enforces membership; a null
    // resolved group (user has no groups, requested none) is rejected here.
    const picked = pickOwnerGroup(principal, b["group"]);
    if (!picked.ok) return res.status(403).json({ error: { code: "GROUP_NOT_ALLOWED", message: `not a member of group: ${String(b["group"])}` } });
    if (!picked.group) return res.status(400).json({ error: { code: "MISSING_GROUP", message: "a credential must be owned by a group" } });

    const credential = await gitCredentialStore.upsert({
      host,
      ownerGroup: picked.group,
      ownerUser: principal.id,
      label,
      plaintextToken: token,
      username,
      createdBy: principal.id,
    });
    // Never echo the token — the operator already holds the PAT.
    res.status(201).json({ credential });
  } catch (err) {
    next(err);
  }
});

// GET /git-credentials → { credentials: [...] } (redacted; hard-isolated by group/owner)
gitCredentialsRouter.get("/git-credentials", authorize("git-credentials:read"), async (_req, res, next) => {
  try {
    const principal = res.locals.principal;
    const all = await gitCredentialStore.list();
    const visible = all.filter((c) => canRead(principal, { ownerGroup: c.ownerGroup, ownerUser: c.ownerUser }));
    res.json({ credentials: visible });
  } catch (err) {
    next(err);
  }
});

// DELETE /git-credentials/:id → { ok } (creator or admin)
gitCredentialsRouter.delete("/git-credentials/:id", authorize("git-credentials:manage"), async (req, res, next) => {
  try {
    const id = req.params["id"]!;
    const doc = await gitCredentialStore.get(id);
    if (!doc) return res.status(404).json({ error: { code: "NOT_FOUND" } });
    if (!canWrite(res.locals.principal, { ownerGroup: doc.ownerGroup, ownerUser: doc.ownerUser })) {
      return res.status(403).json({ error: { code: "NOT_OWNER" } });
    }
    await gitCredentialStore.remove(id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /git-credentials/resolve  { repoUrl? | host?, ref? } → { host, username, token, credentialId }
// The SDK endpoint. Strictly scoped to the caller's own groups — NO admin
// bypass — so even an admin key only resolves its own group's secret.
gitCredentialsRouter.post("/git-credentials/resolve", authorize("git-credentials:read"), async (req, res, next) => {
  try {
    // PAT in the body — never cache, never log.
    res.setHeader("Cache-Control", "no-store");
    if (!credentialsKeyConfigured()) {
      return res.status(503).json({ error: { code: "CREDENTIALS_KEY_NOT_CONFIGURED" } });
    }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const raw = typeof b["repoUrl"] === "string" ? b["repoUrl"] : typeof b["host"] === "string" ? b["host"] : "";
    const host = normalizeGitHost(raw);
    if (!host) return res.status(400).json({ error: { code: "MISSING_HOST_OR_REPO_URL" } });

    const principal = res.locals.principal!;
    const found = await gitCredentialStore.resolve({ ownerGroups: principal.groups, host });
    if (!found) return res.status(404).json({ error: { code: "NO_CREDENTIAL", message: `no git credential for host ${host} in your group(s)` } });

    res.json({
      host: found.doc.host,
      username: found.doc.username || DEFAULT_USERNAME,
      token: found.token,
      credentialId: found.doc._id,
    });
  } catch (err) {
    next(err);
  }
});
