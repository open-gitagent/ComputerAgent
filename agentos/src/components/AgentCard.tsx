import { GitBranch, FolderTree, Code2, MessageSquare, Activity, Clock, ExternalLink, Trash2 } from "lucide-react";
import { type Agent, displaySource } from "../api.ts";
import { Badge } from "./ui/badge.tsx";
import { cn } from "../lib/cn.ts";

function typeLogo(harness: string): string | null {
  if (harness === "gitagent") return "/logos/gitagent.png";
  if (harness === "claude-agent-sdk") return "/logos/claude.svg";
  if (harness === "deepagents") return "/logos/langchain.svg";
  return null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Single agent card for the rail.
 *
 * Two zones with a hairline divider between them:
 *   Top:    avatar (harness logo on white) + name + status pill + LIB/1-shot chip
 *           source line: owner/repo with kind glyph + clickable external icon
 *   Bottom: stat row — sessions / logs / lastActivity, each with icon
 *
 * Click anywhere on the card opens the agent's workspace (chat). The
 * external-link icon is the only nested clickable; stopPropagation
 * prevents card-click bubbling.
 */
export function AgentCard({
  agent: a,
  selected,
  onClick,
  onDelete,
}: {
  agent: Agent;
  selected: boolean;
  onClick: () => void;
  /** When provided, a trash affordance shows on hover (used by the registry). */
  onDelete?: () => void;
}) {
  // Show the registered name exactly as typed — never derive it from the
  // source URL. The source/repo still renders on its own line below.
  const displayName = a.name;
  const sourceUrl = a.sourceUrl ?? "";
  const harnessLogo = typeLogo(a.harness);
  const initial = displayName.charAt(0).toUpperCase();
  const isLive = a.activeSandboxes > 0;
  const sd = displaySource(a.source);

  return (
    <button
      onClick={onClick}
      className={cn(
        "group relative w-full text-left rounded-xl border bg-background transition overflow-hidden shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary/50 ring-1 ring-primary/30 shadow-md shadow-primary/10"
          : "border-border/60 hover:border-border hover:bg-muted/30 hover:shadow-md",
      )}
    >
      {onDelete && (
        <span
          role="button"
          tabIndex={0}
          title="Delete agent"
          aria-label={`Delete ${a.name}`}
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onDelete(); }
          }}
          className="absolute right-2 top-2 z-10 h-6 w-6 grid place-items-center rounded-md text-muted-foreground/70 opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-opacity cursor-pointer"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </span>
      )}

      {/* HEADER */}
      <div className="px-3 pt-3 pb-2.5">
        <div className="flex items-start gap-2.5 min-w-0">
          {/* Avatar */}
          <div className="relative shrink-0">
            {harnessLogo ? (
              <span className="h-9 w-9 grid place-items-center rounded-lg bg-white ring-1 ring-border shadow-sm">
                <img src={harnessLogo} alt="" className="h-4 w-4 object-contain" />
              </span>
            ) : (
              <span className="h-9 w-9 grid place-items-center rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 text-primary text-sm font-bold ring-1 ring-primary/20">
                {initial}
              </span>
            )}
            <span
              title={isLive ? `${a.activeSandboxes} live` : "idle"}
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card",
                isLive ? "bg-emerald-400" : "bg-muted-foreground/40",
              )}
            />
          </div>

          {/* Name + badges */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-semibold text-[13.5px] text-foreground truncate" title={displayName}>
                {displayName}
              </span>
              {a.origin === "registry" && (
                <Badge variant="secondary" className="shrink-0 h-4 text-[9px] uppercase tracking-wider px-1.5 font-medium" title={`Registered via SDK${a.registeredBy ? ` by ${a.registeredBy}` : ""}`}>
                  lib
                </Badge>
              )}
              {!a.sandboxCapable && (
                <Badge variant="outline" className="shrink-0 h-4 text-[9px] uppercase tracking-wider px-1.5 border-amber-500/40 text-amber-500" title="one-shot — no memory across turns">
                  1-shot
                </Badge>
              )}
            </div>
            <div className="mt-0.5 text-[10.5px] text-muted-foreground/80 font-mono truncate" title={a.harness}>
              {a.harness}
            </div>
          </div>
        </div>

        {/* Source row */}
        {sourceUrl && (
          <div className="mt-2.5 flex items-center gap-1.5 min-w-0 text-[11px] text-muted-foreground/90">
            <SourceGlyph kind={sd.kind} />
            <span className="truncate min-w-0 flex-1 font-mono" title={sd.primary}>
              {sd.primary}
            </span>
            {sd.href && (
              <a
                href={sd.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                title={`Open on ${sd.secondary}`}
                aria-label={`Open ${sd.primary} on ${sd.secondary}`}
                className="shrink-0 h-5 w-5 grid place-items-center rounded text-muted-foreground hover:text-primary hover:bg-muted transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* Hairline */}
      <div className="h-px bg-border/60 mx-3" />

      {/* FOOTER */}
      <div className="px-3 py-1.5 flex items-center gap-2.5 text-[10.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1" title={`${a.sessionCount} session${a.sessionCount === 1 ? "" : "s"}`}>
          <MessageSquare className="h-3 w-3" /> <span className="font-mono">{a.sessionCount}</span>
        </span>
        <span className="inline-flex items-center gap-1" title={`${a.logCount} log${a.logCount === 1 ? "" : "s"}`}>
          <Activity className="h-3 w-3" /> <span className="font-mono">{a.logCount}</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-1" title={a.lastActivity ?? a.lastSeen ?? "no activity"}>
          <Clock className="h-3 w-3" /> {timeAgo(a.lastActivity ?? a.lastSeen ?? null)}
        </span>
      </div>
    </button>
  );
}

function SourceGlyph({ kind }: { kind: "git" | "local" | "inline" | "unknown" }) {
  if (kind === "git") return <GitBranch className="h-3 w-3 shrink-0" />;
  if (kind === "local") return <FolderTree className="h-3 w-3 shrink-0" />;
  if (kind === "inline") return <Code2 className="h-3 w-3 shrink-0" />;
  return <span className="h-3 w-3 inline-block shrink-0" />;
}
