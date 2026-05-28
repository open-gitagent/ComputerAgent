import { useEffect, useState } from "react";
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from "react-resizable-panels";
import { Plus, PanelLeftClose, MessageSquare } from "lucide-react";
import { api, type SessionSummary } from "../api.ts";
import { ChatTab } from "./ChatTab.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { EmptyState } from "./composite/EmptyState.tsx";
import { cn } from "../lib/cn.ts";

export function WorkspaceTab({
  agent,
  sandboxCapable,
  initialMessage,
  onConsumedInitial,
}: {
  agent: string;
  sandboxCapable: boolean;
  initialMessage?: string | null;
  onConsumedInitial?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string>(() => `new-${Date.now()}`);

  const loadSessions = () => {
    setLoading(true);
    api.sessions(agent, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  };
  useEffect(loadSessions, [agent]);

  useEffect(() => {
    setResumeId(null);
    setChatKey(`new-${agent}-${Date.now()}`);
  }, [agent]);

  const openSession = (sid: string) => {
    setResumeId(sid);
    setChatKey(`s-${sid}-${Date.now()}`);
  };
  const newChat = () => {
    setResumeId(null);
    setChatKey(`new-${Date.now()}`);
  };

  if (collapsed) {
    return (
      <div className="h-full flex">
        <div className="w-11 shrink-0 border-r border-border flex flex-col items-center py-3 gap-2 bg-card">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(false)}
            title="Show sessions"
            className="h-8 w-8"
          >
            <PanelLeftClose className="h-4 w-4 rotate-180" />
          </Button>
          <Button onClick={newChat} size="icon" title="New chat" className="h-8 w-8">
            <Plus className="h-4 w-4" />
          </Button>
          <div className="mt-1 text-[10px] text-muted-foreground [writing-mode:vertical-rl] rotate-180 tracking-wide">
            {sessions.length} sessions
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <ChatTab
            key={chatKey}
            agent={agent}
            sandboxCapable={sandboxCapable}
            resumeSessionId={resumeId}
            onConsumedResume={() => {}}
            initialMessage={initialMessage}
            onConsumedInitial={() => {
              onConsumedInitial?.();
              loadSessions();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <PanelGroup orientation="horizontal" className="h-full">
      <Panel defaultSize={22} minSize={15} maxSize={35} className="bg-card border-r border-border flex flex-col">
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(true)}
            title="Collapse"
            className="h-7 w-7 -ml-1"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>
          <Button variant="default" size="sm" onClick={newChat} className="ml-auto">
            <Plus className="h-3 w-3" />
            New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-3 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}
          {!loading && sessions.length === 0 && (
            <EmptyState
              icon={MessageSquare}
              title={sandboxCapable ? "No sessions yet" : "One-shot agent"}
              body={sandboxCapable ? "Start a chat to create your first session." : "Runs aren't saved as sessions."}
            />
          )}
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              onClick={() => openSession(s.sessionId)}
              className={cn(
                "w-full text-left px-4 py-3 border-b border-border/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                resumeId === s.sessionId ? "bg-muted ring-1 ring-primary/40" : "hover:bg-muted/40",
              )}
            >
              <div className="text-xs font-mono truncate text-foreground/90">{s.sessionId.replace(/^slack-/, "")}</div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {s.sandboxId && (
                  <Badge variant="success" className="text-[9px] py-0">
                    warm
                  </Badge>
                )}
                {s.snapshotId && (
                  <Badge variant="secondary" className="text-[9px] py-0">
                    snapshot
                  </Badge>
                )}
                <span className="ml-auto">{s.lastMessageAt ? new Date(s.lastMessageAt).toLocaleString() : ""}</span>
              </div>
            </button>
          ))}
        </div>
      </Panel>

      <PanelResizeHandle className="w-1 bg-transparent hover:bg-primary/40 transition-colors" />

      <Panel className="min-w-0">
        <ChatTab
          key={chatKey}
          agent={agent}
          sandboxCapable={sandboxCapable}
          resumeSessionId={resumeId}
          onConsumedResume={() => {}}
          initialMessage={initialMessage}
          onConsumedInitial={() => {
            onConsumedInitial?.();
            loadSessions();
          }}
        />
      </Panel>
    </PanelGroup>
  );
}
