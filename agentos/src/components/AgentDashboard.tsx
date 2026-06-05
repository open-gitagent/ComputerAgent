// The /agents/:name page. Reads the agent name from the route, looks it up in
// the shared agents context, and renders the dashboard header + the four
// in-page tabs (chat / schedules / policy / logs). The sub-tabs are local
// state by design — they do not get their own URL.

import { useState } from "react";
import { useNavigate, useParams, useLocation, Link } from "react-router-dom";
import { type Agent } from "../api.ts";
import { useAgents } from "../context/AgentsContext.tsx";
import { LogsTab } from "./LogsTab.tsx";
import { WorkspaceTab } from "./WorkspaceTab.tsx";
import { SchedulesTab } from "./SchedulesTab.tsx";
import { PolicyTab } from "./PolicyTab.tsx";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs.tsx";
import { Badge } from "./ui/badge.tsx";
import { PageHeader } from "./composite/PageHeader.tsx";
import { cn } from "../lib/cn.ts";

type Tab = "chat" | "schedules" | "policy" | "logs";

function typeLogo(harness: string): string | null {
  if (harness === "gitagent") return "/logos/gitagent.png";
  if (harness === "claude-agent-sdk") return "/logos/claude.svg";
  if (harness === "deepagents") return "/logos/langchain.svg";
  return null;
}

function TypeBadge({ agent, className = "" }: { agent: Agent; className?: string }) {
  const logo = typeLogo(agent.harness);
  return (
    <Badge variant="secondary" className={cn("gap-1.5 pl-1 pr-2 py-0.5 text-[10px] font-normal", className)}>
      {logo && (
        <span className="h-3.5 w-3.5 grid place-items-center rounded-sm bg-background shrink-0">
          <img src={logo} alt="" className="h-2.5 w-2.5 object-contain" />
        </span>
      )}
      <span className="truncate">{agent.label}</span>
    </Badge>
  );
}

export function AgentDashboard() {
  const { id } = useParams<{ id: string }>();
  const { agents, loaded } = useAgents();
  const navigate = useNavigate();
  const location = useLocation();
  const [tab, setTab] = useState<Tab>("chat");

  // Launch message handed over from the Home page via route state.
  const [launchMessage, setLaunchMessage] = useState<string | null>(
    (location.state as { message?: string } | null)?.message ?? null,
  );

  const agent = agents.find((a) => a.id === id) ?? null;

  if (!loaded) {
    return <div className="flex-1 grid place-items-center text-muted-foreground">Loading…</div>;
  }
  if (!agent) {
    return (
      <div className="flex-1 grid place-items-center text-muted-foreground">
        <div className="text-center space-y-2">
          <div>Unknown agent <span className="font-mono">{id}</span>.</div>
          <Link to="/registry" className="text-primary hover:underline">Back to registry</Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {agent.name}
            <TypeBadge agent={agent} />
          </span>
        }
        description={
          <>
            {agent.harness} · {agent.model ?? "default model"}
            {!agent.sandboxCapable && (
              <span className="ml-2 text-warning">one-shot · no memory across turns</span>
            )}
            {agent.archived && (
              <span className="ml-2 text-muted-foreground">archived · cannot run until unarchived</span>
            )}
          </>
        }
        actions={
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="chat">Chat</TabsTrigger>
              <TabsTrigger value="schedules">Schedules</TabsTrigger>
              <TabsTrigger value="policy">Policy</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      <section className="flex-1 min-h-0">
        {tab === "chat" && (
          <WorkspaceTab
            key={agent.id}
            agentId={agent.id}
            agentName={agent.name}
            sandboxCapable={agent.sandboxCapable}
            liveChatCapable={agent.liveChatCapable !== false}
            archived={agent.archived === true}
            initialMessage={agent.archived ? null : launchMessage}
            onConsumedInitial={() => setLaunchMessage(null)}
          />
        )}
        {tab === "schedules" && <SchedulesTab key={agent.id} agentId={agent.id} agentLabel={agent.label} />}
        {tab === "policy" && (
          <PolicyTab
            key={agent.id}
            agentId={agent.id}
            agentLabel={agent.label}
            onManagePolicies={() => navigate("/policies")}
          />
        )}
        {tab === "logs" && <LogsTab key={agent.id} agentId={agent.id} />}
      </section>
    </>
  );
}
