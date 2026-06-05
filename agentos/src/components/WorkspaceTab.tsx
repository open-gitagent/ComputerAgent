import { useEffect, useState } from "react";
import { Plus, PanelLeftClose, MessageSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, type SessionSummary } from "../api.ts";
import { ChatTab } from "./ChatTab.tsx";
import { Button } from "./ui/button.tsx";
import { Badge } from "./ui/badge.tsx";
import { Skeleton } from "./ui/skeleton.tsx";
import { EmptyState } from "./composite/EmptyState.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog.tsx";
import { cn } from "../lib/cn.ts";

export function WorkspaceTab({
  agentId,
  agentName,
  sandboxCapable,
  liveChatCapable = true,
  initialMessage,
  onConsumedInitial,
}: {
  agentId: string;
  agentName: string;
  sandboxCapable: boolean;
  // True when the agent can spin up a live chat sandbox. False for
  // library-mode agents (Python harness etc.) whose ``source`` doesn't
  // resolve into something the server can clone. Defaults to true so
  // existing callers and registry docs without the field keep working.
  liveChatCapable?: boolean;
  initialMessage?: string | null;
  onConsumedInitial?: () => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [resumeId, setResumeId] = useState<string | null>(null);
  // Session the open ChatTab is actually talking to. Set when a new chat boots
  // (so it highlights in the list) without remounting the chat via `resumeId`.
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string>(() => `new-${Date.now()}`);
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadSessions = () => {
    setLoading(true);
    api.sessions(agentId, 100)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  };
  useEffect(loadSessions, [agentId]);

  useEffect(() => {
    setResumeId(null);
    setChatKey(`new-${agentId}-${Date.now()}`);
  }, [agentId]);

  const openSession = (sid: string) => {
    setResumeId(sid);
    setActiveSessionId(sid);
    setChatKey(`s-${sid}-${Date.now()}`);
  };
  const newChat = () => {
    setResumeId(null);
    setActiveSessionId(null);
    setChatKey(`new-${Date.now()}`);
  };
  // A new chat's session only exists once its sandbox boots — surface it in the
  // list (and highlight it) without remounting the live ChatTab.
  const onSessionStarted = (sid: string) => {
    setActiveSessionId(sid);
    loadSessions();
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const sid = pendingDelete.sessionId;
    setDeleting(true);
    try {
      const res = await api.deleteSession(sid, agentId);
      const d = res.deleted;
      toast.success("Session deleted", {
        description: `${d.sandboxes} sandbox(es), ${d.snapshots} snapshot(s) removed.`,
      });
      if (res.warnings?.length) {
        toast.warning("Some cleanup was skipped", { description: res.warnings.slice(0, 3).join("; ") });
      }
      setPendingDelete(null);
      // If the deleted session was open, drop back to a fresh chat.
      if (resumeId === sid || activeSessionId === sid) newChat();
      loadSessions();
    } catch (e) {
      toast.error(`Delete failed: ${String(e)}`);
    } finally {
      setDeleting(false);
    }
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
          {liveChatCapable && (
            <Button onClick={newChat} size="icon" title="New chat" className="h-8 w-8">
              <Plus className="h-4 w-4" />
            </Button>
          )}
          <div className="mt-1 text-[10px] text-muted-foreground [writing-mode:vertical-rl] rotate-180 tracking-wide">
            {sessions.length} sessions
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <ChatTab
            key={chatKey}
            agentId={agentId}
            agentName={agentName}
            sandboxCapable={sandboxCapable}
            resumeSessionId={resumeId}
            onConsumedResume={() => {}}
            initialMessage={initialMessage}
            onConsumedInitial={() => {
              onConsumedInitial?.();
              loadSessions();
            }}
            onSessionStarted={onSessionStarted}
          />
        </div>
      </div>
    );
  }

  return (
    // Fixed-width session list (no draggable handle — that was unreachable
    // with the 4px PanelResizeHandle). Collapse via the button instead.
    <div className="h-full flex min-w-0">
      <aside className="w-64 shrink-0 bg-card border-r border-border flex flex-col">
        <div className="px-3 py-2.5 border-b border-border flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(true)}
            title="Collapse"
            className="h-7 w-7 shrink-0"
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground truncate min-w-0">
            {sessions.length} session{sessions.length !== 1 ? "s" : ""}
          </span>
          {liveChatCapable && (
            <Button variant="default" size="sm" onClick={newChat} className="ml-auto shrink-0 gap-1">
              <Plus className="h-3 w-3" />
              New
            </Button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto min-w-0">
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
          {sessions.map((s) => {
            // Chop the agentos-<agentname>- prefix so the unique part is
            // visible at the START of the truncated label.
            const label = s.sessionId.replace(/^agentos-[a-z0-9-]+?-/, "");
            const ts = s.lastMessageAt ? new Date(s.lastMessageAt) : null;
            const tsShort = ts
              ? ts.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
              : "";
            return (
              <div key={s.sessionId} className="group relative border-b border-border/50">
                <button
                  title={s.sessionId}
                  onClick={() => openSession(s.sessionId)}
                  className={cn(
                    "w-full text-left px-3 py-2.5 pr-8 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset min-w-0",
                    activeSessionId === s.sessionId ? "bg-muted ring-1 ring-primary/40" : "hover:bg-muted/40",
                  )}
                >
                  <div className="text-xs font-mono truncate text-foreground/90 min-w-0">{label}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground min-w-0">
                    {s.warm && (
                      <Badge variant="success" className="shrink-0 text-[9px] py-0 px-1.5">warm</Badge>
                    )}
                    <span className="ml-auto truncate min-w-0">{tsShort}</span>
                  </div>
                </button>
                <span
                  role="button"
                  tabIndex={0}
                  title="Delete session"
                  aria-label={`Delete session ${label}`}
                  onClick={(e) => { e.stopPropagation(); setPendingDelete(s); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setPendingDelete(s); }
                  }}
                  className="absolute right-1.5 top-2 z-10 h-6 w-6 grid place-items-center rounded-md text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </span>
              </div>
            );
          })}
        </div>
      </aside>

      <div className="flex-1 min-w-0">
        <ChatTab
          key={chatKey}
          agentId={agentId}
          agentName={agentName}
          sandboxCapable={sandboxCapable}
          resumeSessionId={resumeId}
          onConsumedResume={() => {}}
          initialMessage={initialMessage}
          onConsumedInitial={() => {
            onConsumedInitial?.();
            loadSessions();
          }}
          onSessionStarted={onSessionStarted}
        />
      </div>

      <AlertDialog open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete session?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes this conversation, its live sandbox, and any saved
              workspace state in S3. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
