// Unit test for the read-only Keycloak admin client: config detection, the
// client_credentials token cache, and that admin reads carry the bearer token.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  vi.resetModules();
  process.env["KEYCLOAK_ISSUER_URL"] = "https://kc.example/realms/computer-agent";
  process.env["OIDC_CLIENT_ID"] = "agent-os-server-client";
  process.env["OIDC_CLIENT_SECRET"] = "secret";
  delete process.env["KEYCLOAK_ADMIN_CLIENT_ID"];
  delete process.env["KEYCLOAK_ADMIN_CLIENT_SECRET"];
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["KEYCLOAK_ISSUER_URL"];
  delete process.env["OIDC_CLIENT_ID"];
  delete process.env["OIDC_CLIENT_SECRET"];
});

describe("keycloak-admin", () => {
  it("keycloakAdminConfigured reflects issuer + client creds", async () => {
    const mod = await import("./keycloak-admin.js");
    expect(mod.keycloakAdminConfigured()).toBe(true);
    delete process.env["OIDC_CLIENT_SECRET"];
    expect(mod.keycloakAdminConfigured()).toBe(false);
  });

  it("fetches a token once (cached) and lists groups with the bearer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "T1", expires_in: 300 }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: "g1", name: "team-a", path: "/team-a" }]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { listGroups } = await import("./keycloak-admin.js");
    const groups = await listGroups();
    expect(groups[0]!.name).toBe("team-a");
    await listGroups(); // token reused

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 token + 2 group reads
    expect(String(fetchMock.mock.calls[0]![0])).toContain("/protocol/openid-connect/token");
    expect(String(fetchMock.mock.calls[1]![0])).toContain("/admin/realms/computer-agent/groups");
    const init = fetchMock.mock.calls[1]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer T1");
  });

  it("surfaces a KeycloakAdminError on a non-2xx admin response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "T1", expires_in: 300 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const { listGroups, KeycloakAdminError } = await import("./keycloak-admin.js");
    await expect(listGroups()).rejects.toBeInstanceOf(KeycloakAdminError);
  });
});
