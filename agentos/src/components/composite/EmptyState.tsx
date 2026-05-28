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
    <div className={cn("flex flex-col items-center justify-center text-center px-6 py-12 gap-3", className)}>
      {Icon && (
        <div className="rounded-full bg-muted p-3 text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <div className="space-y-1 max-w-md">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {body && <div className="text-xs text-muted-foreground">{body}</div>}
      </div>
      {cta && <div className="pt-2">{cta}</div>}
    </div>
  );
}
