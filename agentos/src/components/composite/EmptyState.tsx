import * as React from "react";
import { cn } from "../../lib/cn.ts";

export function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
  className,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  body?: React.ReactNode;
  cta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Containerized: this empty state is often rendered in narrow panels
        // (session list, agent rail). Cap text width to the container; never
        // overflow horizontally; let long words break instead of wrapping the
        // entire phrase to one-word-per-line.
        "flex flex-col items-center justify-center text-center gap-3 mx-auto",
        "min-w-0 max-w-full w-full",
        "px-3 py-8 sm:px-6 sm:py-12",
        "[overflow-wrap:anywhere]",
        className,
      )}
    >
      {Icon && (
        <div className="rounded-full bg-muted p-3 text-muted-foreground shrink-0">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="space-y-1 max-w-xs min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{title}</div>
        {body && <div className="text-xs text-muted-foreground">{body}</div>}
      </div>
      {cta && <div className="pt-2">{cta}</div>}
    </div>
  );
}
