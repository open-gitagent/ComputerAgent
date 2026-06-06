/**
 * Settings — system-level configuration, reached from the bottom of the sidebar.
 * Tabs are gated by the signed-in principal's permissions: "API Keys" needs
 * keys:read, "Roles" needs roles:manage. A sign-out control lives at the bottom.
 */
import { KeyRound, ShieldCheck, Users2, LogOut, GitBranch } from "lucide-react";
import { PageHeader } from "./composite/PageHeader.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Button } from "./ui/button.tsx";
import { ApiKeysSection } from "./settings/ApiKeysSection.tsx";
import { GitCredentialsSection } from "./settings/GitCredentialsSection.tsx";
import { RolesSection } from "./settings/RolesSection.tsx";
import { GroupsSection } from "./settings/GroupsSection.tsx";
import { useAuth } from "../context/AuthContext.tsx";

export function SettingsPage() {
  const { can, me, logout } = useAuth();
  const showKeys = can("keys:read");
  const showGitCreds = can("git-credentials:read");
  const showRoles = can("roles:manage");
  const showGroups = can("groups:read");
  const defaultTab = showKeys ? "api-keys" : showGitCreds ? "git-credentials" : showRoles ? "roles" : showGroups ? "groups" : "none";

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" description="System-level configuration" />
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {showKeys || showGitCreds || showRoles || showGroups ? (
          <Tabs defaultValue={defaultTab} className="w-full">
            <TabsList className="mb-5">
              {showKeys && (
                <TabsTrigger value="api-keys" className="gap-1.5">
                  <KeyRound className="h-3.5 w-3.5" /> API Keys
                </TabsTrigger>
              )}
              {showGitCreds && (
                <TabsTrigger value="git-credentials" className="gap-1.5">
                  <GitBranch className="h-3.5 w-3.5" /> Git Credentials
                </TabsTrigger>
              )}
              {showRoles && (
                <TabsTrigger value="roles" className="gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" /> Roles
                </TabsTrigger>
              )}
              {showGroups && (
                <TabsTrigger value="groups" className="gap-1.5">
                  <Users2 className="h-3.5 w-3.5" /> Groups
                </TabsTrigger>
              )}
            </TabsList>
            {showKeys && (
              <TabsContent value="api-keys">
                <ApiKeysSection />
              </TabsContent>
            )}
            {showGitCreds && (
              <TabsContent value="git-credentials">
                <GitCredentialsSection />
              </TabsContent>
            )}
            {showRoles && (
              <TabsContent value="roles">
                <RolesSection />
              </TabsContent>
            )}
            {showGroups && (
              <TabsContent value="groups">
                <GroupsSection />
              </TabsContent>
            )}
          </Tabs>
        ) : (
          <p className="text-sm text-muted-foreground">No settings are available for your role.</p>
        )}

        <div className="mt-8 flex items-center justify-between border-t border-border pt-4">
          <span className="text-xs text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{me?.user ?? "—"}</span>
            {me?.roles?.length ? ` · ${me.roles.join(", ")}` : " · no roles"}
          </span>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
