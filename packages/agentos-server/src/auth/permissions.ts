// The permission CATALOG — the fixed set of permission keys the code knows
// about. Roles (in Mongo, editable in the UI) map to subsets of these keys.
// This registry is the source of truth for `GET /permissions` (the Roles
// editor's checklist) and for validating role definitions on write.
//
// Keys are `<resource>:<action>`. The wildcard "*" satisfies every check.

export interface PermissionDef {
  key: string;
  description: string;
}

export const WILDCARD = "*";

export const PERMISSIONS: PermissionDef[] = [
  { key: "agents:read", description: "View agents and the registry" },
  { key: "agents:write", description: "Register, edit, archive/unarchive agents" },
  { key: "agents:run", description: "Run agents and start chat sandboxes" },
  { key: "agents:delete", description: "Delete agents (cascade)" },
  { key: "sessions:read", description: "View sessions and transcripts" },
  { key: "sessions:delete", description: "Delete sessions" },
  { key: "schedules:read", description: "View schedules" },
  { key: "schedules:write", description: "Create, edit, and run schedules" },
  { key: "schedules:delete", description: "Delete schedules" },
  { key: "logs:read", description: "View request/reply logs" },
  { key: "logs:write", description: "Append web-console turns" },
  { key: "completion:run", description: "Use the agent-less completion chat" },
  { key: "policies:read", description: "View policies and bindings" },
  { key: "policies:write", description: "Create, edit, delete policies and bindings" },
  { key: "evals:read", description: "View eval suites and runs" },
  { key: "evals:write", description: "Create, edit, and run eval suites" },
  { key: "obs:read", description: "View observability traces and dashboards" },
  { key: "keys:read", description: "View API keys" },
  { key: "keys:manage", description: "Mint and revoke API keys" },
  { key: "roles:manage", description: "View and edit roles and permissions" },
  { key: "groups:read", description: "View groups + members (read-only, from Keycloak)" },
];

export const PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);

/** True for the wildcard or any catalogued key — used to validate role writes. */
export function isKnownPermission(key: string): boolean {
  return key === WILDCARD || PERMISSION_KEYS.includes(key);
}
