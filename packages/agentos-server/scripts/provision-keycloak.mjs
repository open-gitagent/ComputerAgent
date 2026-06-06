// Idempotent Keycloak provisioning for AgentOS.
//
// Creates (or updates, re-runnable) everything AgentOS needs in a Keycloak
// realm so nothing has to be clicked together by hand:
//
//   1. the realm                              (REALM, created if missing)
//   2. realm roles                            agentos-admin / -editor / -viewer
//   3. the OIDC client (confidential, BFF)    CLIENT_ID, with a pinned secret,
//        standard flow + service accounts, redirect URIs / web origins
//   4. protocol mappers on the client         Group Membership -> `groups`
//        (+ optional audience mapper)         (realm roles ride the default
//                                              `roles` client scope already)
//   5. service-account realm-management roles view-realm / view-users / view-clients
//        so the server's Admin-API fallback (groups view + group enrichment) works
//   6. (optional) groups                       GROUPS_JSON, each optionally role-mapped
//   7. (optional) bootstrap admin              BOOTSTRAP_ADMIN_EMAIL -> agentos-admin
//   8. (optional) test users                   USERS_JSON (local testing)
//   9. (optional) Okta IdP federation          OKTA_ISSUER/CLIENT_ID/CLIENT_SECRET
//
// Auth: a Keycloak master-realm admin (password grant via the built-in
// `admin-cli` client). This is the bootstrap credential — it is NOT stored.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   KEYCLOAK_URL=https://keycloak.test.studio.lyzr.ai \
//   KC_ADMIN_USER=admin KC_ADMIN_PASSWORD=secret \
//   REALM=computer-agent \
//   CLIENT_ID=agent-os-server-client \
//   CLIENT_SECRET=yL2WJtHVa0qINSOy0AUEIO40KY4FcPyW \
//   REDIRECT_URIS=http://localhost:8788/agentos/api/v1/auth/callback,http://localhost:5173/* \
//     node packages/agentos-server/scripts/provision-keycloak.mjs
//
//   # preview without writing:
//   DRY_RUN=1 ... node packages/agentos-server/scripts/provision-keycloak.mjs
//
// Re-running is safe: each object is checked and created-or-updated, never
// duplicated.

// ── Config ───────────────────────────────────────────────────────────────────
const KC = (process.env.KEYCLOAK_URL || "").replace(/\/+$/, "");
const ADMIN_REALM = process.env.KC_ADMIN_REALM || "master";
const ADMIN_CLIENT = process.env.KC_ADMIN_CLIENT || "admin-cli";
const ADMIN_USER = process.env.KC_ADMIN_USER || "";
const ADMIN_PASS = process.env.KC_ADMIN_PASSWORD || "";

const REALM = process.env.REALM || "computer-agent";
const CLIENT_ID = process.env.CLIENT_ID || "agent-os-server-client";
const CLIENT_SECRET = process.env.CLIENT_SECRET || ""; // pin one, or leave blank to keep/generate
const CLIENT_NAME = process.env.CLIENT_NAME || "AgentOS Server (BFF)";

const REDIRECT_URIS = (process.env.REDIRECT_URIS ||
  "http://localhost:8788/agentos/api/v1/auth/callback,http://localhost:5173/*")
  .split(",").map((s) => s.trim()).filter(Boolean);
const WEB_ORIGINS = (process.env.WEB_ORIGINS || "+").split(",").map((s) => s.trim()).filter(Boolean);

const GROUPS_FULL_PATH = (process.env.GROUPS_FULL_PATH ?? "true") === "true";
const AUDIENCE = process.env.OIDC_AUDIENCE || ""; // optional audience mapper

const DRY_RUN = process.env.DRY_RUN === "1";

// Optional extras.
const GROUPS_JSON = process.env.GROUPS_JSON || ""; // e.g. '[{"name":"Platform"},{"name":"agentos-admins","roles":["agentos-admin"]}]'
const BOOTSTRAP_ADMIN_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL || "";
const USERS_JSON = process.env.USERS_JSON || ""; // e.g. '[{"email":"a@b.com","password":"x","groups":["Platform"],"roles":["agentos-viewer"]}]'
const OKTA_ISSUER = (process.env.OKTA_ISSUER || "").replace(/\/+$/, "");
const OKTA_CLIENT_ID = process.env.OKTA_CLIENT_ID || "";
const OKTA_CLIENT_SECRET = process.env.OKTA_CLIENT_SECRET || "";

// The three roles AgentOS seeds into its `roles` collection. Keycloak only needs
// the NAMES to match; the permission sets live (and are editable) in AgentOS.
const REALM_ROLES = [
  { name: "agentos-admin", description: "AgentOS: full access to everything." },
  { name: "agentos-editor", description: "AgentOS: manage and run agents, schedules, evals." },
  { name: "agentos-viewer", description: "AgentOS: read-only access." },
];

// realm-management client roles granted to the BFF client's service account, so
// the server can read groups/members/user-groups via the Admin API.
const SERVICE_ACCOUNT_ROLES = ["view-realm", "view-users", "view-clients"];

if (!KC || !ADMIN_USER || !ADMIN_PASS) {
  console.error("✗ KEYCLOAK_URL, KC_ADMIN_USER and KC_ADMIN_PASSWORD are required.");
  process.exit(1);
}

// ── Logging helpers ──────────────────────────────────────────────────────────
const log = {
  step: (m) => console.log(`\n▸ ${m}`),
  ok: (m) => console.log(`  ✓ ${m}`),
  add: (m) => console.log(`  + ${m}`),
  upd: (m) => console.log(`  ~ ${m}`),
  skip: (m) => console.log(`  · ${m}`),
  warn: (m) => console.warn(`  ! ${m}`),
};
const dry = (m) => DRY_RUN && console.log(`  (dry-run) would ${m}`);

// ── Admin REST client ────────────────────────────────────────────────────────
let token = "";

async function getAdminToken() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: ADMIN_CLIENT,
    username: ADMIN_USER,
    password: ADMIN_PASS,
  });
  const r = await fetch(`${KC}/realms/${ADMIN_REALM}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const d = await r.text().catch(() => "");
    throw new Error(`admin login failed: ${r.status} ${d.slice(0, 300)}`);
  }
  token = (await r.json()).access_token;
}

// Returns parsed JSON, the Location header (for POST creates), or null (204).
async function kc(method, path, body) {
  const r = await fetch(`${KC}/admin/realms${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      accept: "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) {
    const d = await r.text().catch(() => "");
    const err = new Error(`${method} ${path} → ${r.status} ${d.slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  if (r.status === 204) return { location: r.headers.get("location") };
  const text = await r.text();
  const json = text ? JSON.parse(text) : null;
  return { json, location: r.headers.get("location") };
}

const idFromLocation = (loc) => (loc ? loc.split("/").pop() : null);

// ── 1. Realm ───────────────────────────────────────────────────────────────
async function ensureRealm() {
  log.step(`Realm "${REALM}"`);
  try {
    await kc("GET", `/${REALM}`);
    log.ok("exists");
  } catch (e) {
    if (e.status !== 404) throw e;
    if (DRY_RUN) return dry(`create realm ${REALM}`);
    await kc("POST", ``, { realm: REALM, enabled: true, displayName: "ComputerAgent" });
    log.add("created");
  }
}

// ── 2. Realm roles ───────────────────────────────────────────────────────────
async function ensureRealmRoles() {
  log.step("Realm roles");
  for (const role of REALM_ROLES) {
    try {
      await kc("GET", `/${REALM}/roles/${encodeURIComponent(role.name)}`);
      log.ok(role.name);
    } catch (e) {
      if (e.status !== 404) throw e;
      if (DRY_RUN) { dry(`create role ${role.name}`); continue; }
      await kc("POST", `/${REALM}/roles`, role);
      log.add(role.name);
    }
  }
}

// ── 3. OIDC client ───────────────────────────────────────────────────────────
async function ensureClient() {
  log.step(`OIDC client "${CLIENT_ID}"`);
  const found = (await kc("GET", `/${REALM}/clients?clientId=${encodeURIComponent(CLIENT_ID)}`)).json;
  const desired = {
    clientId: CLIENT_ID,
    name: CLIENT_NAME,
    protocol: "openid-connect",
    enabled: true,
    publicClient: false, // confidential — has a secret
    standardFlowEnabled: true, // authorization code (BFF)
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: true, // for the Admin-API fallback
    redirectUris: REDIRECT_URIS,
    webOrigins: WEB_ORIGINS,
    fullScopeAllowed: true,
    attributes: { "post.logout.redirect.uris": "+" },
    ...(CLIENT_SECRET ? { secret: CLIENT_SECRET } : {}),
  };

  let uuid;
  if (found && found.length) {
    uuid = found[0].id;
    if (DRY_RUN) { dry(`update client ${CLIENT_ID}`); }
    else { await kc("PUT", `/${REALM}/clients/${uuid}`, { ...found[0], ...desired }); log.upd("updated"); }
  } else if (DRY_RUN) {
    dry(`create client ${CLIENT_ID}`);
    return null;
  } else {
    const res = await kc("POST", `/${REALM}/clients`, desired);
    uuid = idFromLocation(res.location);
    log.add("created");
  }

  if (uuid && !DRY_RUN) {
    const sec = (await kc("GET", `/${REALM}/clients/${uuid}/client-secret`)).json;
    log.ok(`client secret: ${CLIENT_SECRET ? "set as provided" : sec?.value ?? "(unknown)"}`);
    if (!CLIENT_SECRET && sec?.value) log.warn(`copy this into OIDC_CLIENT_SECRET → ${sec.value}`);
  }
  return uuid;
}

// ── 4. Protocol mappers ──────────────────────────────────────────────────────
async function ensureMappers(clientUuid) {
  log.step("Protocol mappers");
  if (!clientUuid) return dry("add groups (+ audience) mappers");
  const existing = (await kc("GET", `/${REALM}/clients/${clientUuid}/protocol-mappers/models`)).json || [];
  const has = (name) => existing.some((m) => m.name === name);

  const mappers = [
    {
      name: "groups",
      protocol: "openid-connect",
      protocolMapper: "oidc-group-membership-mapper",
      config: {
        "claim.name": "groups",
        "full.path": String(GROUPS_FULL_PATH),
        "id.token.claim": "true",
        "access.token.claim": "true",
        "userinfo.token.claim": "true",
      },
    },
  ];
  if (AUDIENCE) {
    mappers.push({
      name: "audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: {
        "included.client.audience": AUDIENCE,
        "id.token.claim": "false",
        "access.token.claim": "true",
      },
    });
  }

  for (const m of mappers) {
    if (has(m.name)) { log.ok(`${m.name} (exists)`); continue; }
    if (DRY_RUN) { dry(`add mapper ${m.name}`); continue; }
    await kc("POST", `/${REALM}/clients/${clientUuid}/protocol-mappers/models`, m);
    log.add(`mapper ${m.name}`);
  }
  log.skip("realm roles ride the default `roles` client scope (realm_access.roles)");
}

// ── 5. Service-account realm-management roles ────────────────────────────────
async function ensureServiceAccountRoles(clientUuid) {
  log.step("Service-account roles (realm-management)");
  if (!clientUuid) return dry(`grant ${SERVICE_ACCOUNT_ROLES.join(", ")} to the service account`);

  const saUser = (await kc("GET", `/${REALM}/clients/${clientUuid}/service-account-user`)).json;
  const rm = ((await kc("GET", `/${REALM}/clients?clientId=realm-management`)).json || [])[0];
  if (!saUser || !rm) { log.warn("service account or realm-management client not found"); return; }

  const rmRoles = (await kc("GET", `/${REALM}/clients/${rm.id}/roles`)).json || [];
  const assigned = (await kc("GET", `/${REALM}/users/${saUser.id}/role-mappings/clients/${rm.id}`)).json || [];
  const assignedNames = new Set(assigned.map((r) => r.name));

  const toAdd = SERVICE_ACCOUNT_ROLES
    .filter((n) => !assignedNames.has(n))
    .map((n) => rmRoles.find((r) => r.name === n))
    .filter(Boolean)
    .map((r) => ({ id: r.id, name: r.name }));

  for (const n of SERVICE_ACCOUNT_ROLES) if (assignedNames.has(n)) log.ok(`${n} (already granted)`);
  if (!toAdd.length) return;
  if (DRY_RUN) return dry(`grant ${toAdd.map((r) => r.name).join(", ")}`);
  await kc("POST", `/${REALM}/users/${saUser.id}/role-mappings/clients/${rm.id}`, toAdd);
  for (const r of toAdd) log.add(`granted ${r.name}`);
}

// ── 6. Groups (optional) ─────────────────────────────────────────────────────
async function ensureGroups() {
  if (!GROUPS_JSON) return;
  let defs;
  try { defs = JSON.parse(GROUPS_JSON); } catch { log.warn("GROUPS_JSON is not valid JSON — skipping"); return; }
  if (!Array.isArray(defs) || !defs.length) return;

  log.step("Groups");
  const existing = (await kc("GET", `/${REALM}/groups?max=500`)).json || [];
  for (const def of defs) {
    const name = typeof def === "string" ? def : def.name;
    if (!name) continue;
    let group = existing.find((g) => g.name === name);
    if (group) log.ok(name);
    else if (DRY_RUN) { dry(`create group ${name}`); continue; }
    else {
      const res = await kc("POST", `/${REALM}/groups`, { name });
      group = { id: idFromLocation(res.location), name };
      log.add(name);
    }
    // Optional realm-role mapping for the group.
    const roleNames = (def && def.roles) || [];
    if (group?.id && roleNames.length && !DRY_RUN) {
      const reps = [];
      for (const rn of roleNames) {
        try { reps.push((await kc("GET", `/${REALM}/roles/${encodeURIComponent(rn)}`)).json); }
        catch { log.warn(`role ${rn} not found for group ${name}`); }
      }
      if (reps.length) {
        await kc("POST", `/${REALM}/groups/${group.id}/role-mappings/realm`, reps.map((r) => ({ id: r.id, name: r.name })));
        log.add(`${name} → ${reps.map((r) => r.name).join(", ")}`);
      }
    }
  }
}

// ── 7. Bootstrap admin (optional) ────────────────────────────────────────────
async function ensureBootstrapAdmin() {
  if (!BOOTSTRAP_ADMIN_EMAIL) return;
  log.step(`Bootstrap admin (${BOOTSTRAP_ADMIN_EMAIL} → agentos-admin)`);
  const users = (await kc("GET", `/${REALM}/users?email=${encodeURIComponent(BOOTSTRAP_ADMIN_EMAIL)}&exact=true`)).json || [];
  if (!users.length) { log.warn("user not found (federate or create them first)"); return; }
  const role = (await kc("GET", `/${REALM}/roles/agentos-admin`)).json;
  if (DRY_RUN) return dry(`assign agentos-admin to ${BOOTSTRAP_ADMIN_EMAIL}`);
  await kc("POST", `/${REALM}/users/${users[0].id}/role-mappings/realm`, [{ id: role.id, name: role.name }]);
  log.add(`assigned agentos-admin to ${BOOTSTRAP_ADMIN_EMAIL}`);
}

// ── 8. Test users (optional) ─────────────────────────────────────────────────
async function ensureUsers() {
  if (!USERS_JSON) return;
  let defs;
  try { defs = JSON.parse(USERS_JSON); } catch { log.warn("USERS_JSON is not valid JSON — skipping"); return; }
  if (!Array.isArray(defs) || !defs.length) return;

  log.step("Test users");
  for (const u of defs) {
    if (!u.email) continue;
    let user = ((await kc("GET", `/${REALM}/users?email=${encodeURIComponent(u.email)}&exact=true`)).json || [])[0];
    if (user) log.ok(u.email);
    else if (DRY_RUN) { dry(`create user ${u.email}`); continue; }
    else {
      const res = await kc("POST", `/${REALM}/users`, {
        username: u.email, email: u.email, enabled: true, emailVerified: true,
        firstName: u.firstName || u.email.split("@")[0], lastName: u.lastName || "",
        ...(u.password ? { credentials: [{ type: "password", value: u.password, temporary: false }] } : {}),
      });
      user = { id: idFromLocation(res.location) };
      log.add(u.email);
    }
    if (DRY_RUN || !user?.id) continue;
    for (const rn of u.roles || []) {
      try {
        const role = (await kc("GET", `/${REALM}/roles/${encodeURIComponent(rn)}`)).json;
        await kc("POST", `/${REALM}/users/${user.id}/role-mappings/realm`, [{ id: role.id, name: role.name }]);
        log.add(`${u.email} → ${rn}`);
      } catch { log.warn(`role ${rn} not assignable to ${u.email}`); }
    }
    for (const gn of u.groups || []) {
      const g = ((await kc("GET", `/${REALM}/groups?search=${encodeURIComponent(gn)}&max=50`)).json || []).find((x) => x.name === gn);
      if (g) { await kc("PUT", `/${REALM}/users/${user.id}/groups/${g.id}`); log.add(`${u.email} ∈ ${gn}`); }
      else log.warn(`group ${gn} not found for ${u.email}`);
    }
  }
}

// ── 9. Okta IdP federation (optional) ────────────────────────────────────────
async function ensureOktaIdp() {
  if (!OKTA_ISSUER || !OKTA_CLIENT_ID || !OKTA_CLIENT_SECRET) return;
  log.step('Okta IdP federation (alias "okta")');
  // Pull endpoints from Okta's discovery document.
  let disc;
  try {
    disc = await (await fetch(`${OKTA_ISSUER}/.well-known/openid-configuration`)).json();
  } catch { log.warn("could not fetch Okta discovery — skipping IdP"); return; }

  const config = {
    clientId: OKTA_CLIENT_ID,
    clientSecret: OKTA_CLIENT_SECRET,
    issuer: disc.issuer,
    authorizationUrl: disc.authorization_endpoint,
    tokenUrl: disc.token_endpoint,
    jwksUrl: disc.jwks_uri,
    userInfoUrl: disc.userinfo_endpoint,
    logoutUrl: disc.end_session_endpoint || "",
    defaultScope: "openid profile email groups",
    syncMode: "FORCE",
    useJwksUrl: "true",
    validateSignature: "true",
  };
  const rep = { alias: "okta", providerId: "oidc", enabled: true, trustEmail: true, config };

  try {
    await kc("GET", `/${REALM}/identity-provider/instances/okta`);
    if (DRY_RUN) dry("update Okta IdP");
    else { await kc("PUT", `/${REALM}/identity-provider/instances/okta`, rep); log.upd("updated"); }
  } catch (e) {
    if (e.status !== 404) throw e;
    if (DRY_RUN) { dry("create Okta IdP"); return; }
    await kc("POST", `/${REALM}/identity-provider/instances`, rep);
    log.add("created");
  }
  log.skip("map each Okta group → KC group with a 'Claim to Group' IdP mapper (per group)");
}

// ── Run ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`Keycloak: ${KC}`);
  console.log(`Realm:    ${REALM}`);
  console.log(`Client:   ${CLIENT_ID}`);
  if (DRY_RUN) console.log("Mode:     DRY RUN (no writes)\n");

  await getAdminToken();
  await ensureRealm();
  await ensureRealmRoles();
  const clientUuid = await ensureClient();
  await ensureMappers(clientUuid);
  await ensureServiceAccountRoles(clientUuid);
  await ensureGroups();
  await ensureBootstrapAdmin();
  await ensureUsers();
  await ensureOktaIdp();

  console.log(`\n${DRY_RUN ? "Dry run complete — nothing written." : "Done. Keycloak is provisioned for AgentOS."}`);
  if (!DRY_RUN) {
    console.log("\nNext: set these on the agentos-server (already match what was created):");
    console.log(`  KEYCLOAK_ISSUER_URL=${KC}/realms/${REALM}`);
    console.log(`  OIDC_CLIENT_ID=${CLIENT_ID}`);
    console.log(`  OIDC_CLIENT_SECRET=${CLIENT_SECRET || "<the secret printed above>"}`);
    console.log(`  OIDC_REDIRECT_URI=<one of: ${REDIRECT_URIS.join(" | ")}>`);
  }
})().catch((e) => {
  console.error(`\n✗ ${e.message}`);
  process.exit(1);
});
