/**
 * Renders an agent's source as a clickable owner/repo block for git sources,
 * and a plain two-line breakdown for local/inline. The git URL is treated as
 * the agent's canonical identity — two workers registering the same repo
 * under different names share this badge (same `sourceUrl`).
 */
import { type Agent, displaySource } from "../api.ts";

export function SourceBadge({
  agent,
  compact = false,
  linkable = false,
}: {
  agent: Agent;
  compact?: boolean;
  /**
   * When true, the badge renders as an <a> opening the repo in a new tab.
   * Default false — the badge is most often rendered INSIDE the agent-card
   * button, where nesting <a> inside <button> is invalid HTML and browsers
   * preferentially fire the link's navigation instead of the card's click.
   * For a separate-tab affordance, render an <ExternalLinkChip /> next to it.
   */
  linkable?: boolean;
}) {
  const d = displaySource(agent.source);

  const inner = (
    <div className={`flex items-center gap-1.5 min-w-0 ${compact ? "" : "py-0.5"}`}>
      <KindGlyph kind={d.kind} />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-gray-200 font-mono truncate" title={d.primary}>
          {d.primary}
        </div>
        {!compact && (
          <div className="text-[10px] text-gray-500 truncate" title={d.secondary}>
            {d.secondary}
          </div>
        )}
      </div>
      {d.href && (
        <ExternalLinkChip href={d.href} label={`Open ${d.primary} on ${d.secondary}`} />
      )}
    </div>
  );

  if (linkable && d.href) {
    return (
      <a
        href={d.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="block rounded px-1 -mx-1 hover:bg-ink-700/60 transition-colors"
        title={`Open ${d.primary} on ${d.secondary}`}
      >
        {inner}
      </a>
    );
  }
  return inner;
}

/**
 * Tiny external-link chip — used inside agent cards so the row click opens
 * chat while a small explicit icon lets the user jump to the source repo.
 * Rendered as an <a> but with stopPropagation; the parent agent card is a
 * <button>, so this needs to be the only nav target inside it.
 */
function ExternalLinkChip({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={label}
      className="shrink-0 h-5 w-5 grid place-items-center rounded text-gray-500 hover:text-accent-soft hover:bg-ink-700/60 transition-colors"
      aria-label={label}
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
        <path d="M9 2.75a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0V4.56L7.78 9.03a.75.75 0 0 1-1.06-1.06L11.19 3.5H9.75A.75.75 0 0 1 9 2.75zM2.75 4A1.75 1.75 0 0 0 1 5.75v7.5C1 14.216 1.784 15 2.75 15h7.5A1.75 1.75 0 0 0 12 13.25V9.5a.75.75 0 0 0-1.5 0v3.75a.25.25 0 0 1-.25.25h-7.5a.25.25 0 0 1-.25-.25v-7.5a.25.25 0 0 1 .25-.25H6.5a.75.75 0 0 0 0-1.5h-3.75z" />
      </svg>
    </a>
  );
}

function KindGlyph({ kind }: { kind: "git" | "local" | "inline" | "unknown" }) {
  if (kind === "git") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="w-3.5 h-3.5 shrink-0 text-gray-400"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          fillRule="evenodd"
          d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2 .37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"
        />
      </svg>
    );
  }
  if (kind === "local") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="w-3.5 h-3.5 shrink-0 text-gray-500"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2A1.75 1.75 0 0 0 5.1 1H1.75z" />
      </svg>
    );
  }
  if (kind === "inline") {
    return (
      <svg
        viewBox="0 0 16 16"
        className="w-3.5 h-3.5 shrink-0 text-gray-500"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M4.72 3.22a.75.75 0 0 1 1.06 1.06L2.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25zm6.56 0a.75.75 0 1 0-1.06 1.06L13.94 8l-3.72 3.72a.75.75 0 1 0 1.06 1.06l4.25-4.25a.75.75 0 0 0 0-1.06l-4.25-4.25z" />
      </svg>
    );
  }
  return <span className="w-3.5 h-3.5 inline-block shrink-0" />;
}
