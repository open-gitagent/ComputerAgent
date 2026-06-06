// Read-only Keycloak Admin REST client. Groups + membership are owned by
// Okta/Keycloak; this lets an admin VIEW them from AgentOS (it never writes).
//
// Auth: a service-account (client_credentials) token from the admin client
// (KEYCLOAK_ADMIN_CLIENT_ID/SECRET, defaulting to the BFF client). That client's
// service account needs the realm-management role `view-realm` (and `view-users`
// for the members view). The token is cached in-process until it expires.

const env = (n: string): string | undefined => process.env[n];

/** Split KEYCLOAK_ISSUER_URL (".../realms/<realm>") into base + realm. */
function parseIssuer(): { base: string; realm: string } | null {
  const raw = (env("KEYCLOAK_ISSUER_URL") ?? "").replace(/\/+$/, "");
  const m = raw.match(/^(https?:\/\/.+)\/realms\/([^/]+)$/);
  return m ? { base: m[1]!, realm: m[2]! } : null;
}

const adminClientId = (): string => env("KEYCLOAK_ADMIN_CLIENT_ID") || env("OIDC_CLIENT_ID") || "";
const adminClientSecret = (): string => env("KEYCLOAK_ADMIN_CLIENT_SECRET") || env("OIDC_CLIENT_SECRET") || "";

export function keycloakAdminConfigured(): boolean {
  return Boolean(parseIssuer() && adminClientId() && adminClientSecret());
}

export class KeycloakAdminError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "KeycloakAdminError";
  }
}

let tokenCache: { token: string; exp: number } | null = null;

async function getAdminToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.exp - 10_000) return tokenCache.token;
  const iss = parseIssuer();
  if (!iss) throw new KeycloakAdminError("KEYCLOAK_ISSUER_URL not configured");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: adminClientId(),
    client_secret: adminClientSecret(),
  });
  const r = await fetch(`${iss.base}/realms/${iss.realm}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new KeycloakAdminError(`admin token failed: ${r.status} ${detail.slice(0, 200)}`, r.status);
  }
  const j = (await r.json()) as { access_token: string; expires_in?: number };
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 60) * 1000 };
  return tokenCache.token;
}

async function adminGet<T>(path: string): Promise<T> {
  const iss = parseIssuer();
  if (!iss) throw new KeycloakAdminError("KEYCLOAK_ISSUER_URL not configured");
  const token = await getAdminToken();
  const r = await fetch(`${iss.base}/admin/realms/${iss.realm}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new KeycloakAdminError(`GET ${path} → ${r.status} ${detail.slice(0, 200)}`, r.status);
  }
  return r.json() as Promise<T>;
}

export interface KcGroup {
  id: string;
  name: string;
  path: string;
  subGroups?: KcGroup[];
}

export interface KcMember {
  id: string;
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/** Top-level realm groups (brief; includes nested subGroups). */
export function listGroups(): Promise<KcGroup[]> {
  return adminGet<KcGroup[]>(`/groups?briefRepresentation=true&max=500`);
}

export function listGroupMembers(groupId: string, max = 100): Promise<KcMember[]> {
  return adminGet<KcMember[]>(`/groups/${encodeURIComponent(groupId)}/members?max=${max}`);
}

/** Group names a user belongs to, normalized the same way the token's `groups`
 *  claim is (leading "/" stripped from the path) so they compare equal to a
 *  resource's stored `ownerGroup`. Used as a fallback when the access token
 *  carries no `groups` claim (missing Group Membership mapper). */
export async function listUserGroups(userId: string): Promise<string[]> {
  const groups = await adminGet<KcGroup[]>(`/users/${encodeURIComponent(userId)}/groups?max=200`);
  return groups.map((g) => (g.path ?? g.name ?? "").replace(/^\//, "")).filter(Boolean);
}

/** Directly-assigned realm role names for a user (the per-user capability). */
export async function listUserRealmRoles(userId: string): Promise<string[]> {
  const roles = await adminGet<Array<{ name: string }>>(
    `/users/${encodeURIComponent(userId)}/role-mappings/realm`,
  );
  return roles.map((r) => r.name);
}
