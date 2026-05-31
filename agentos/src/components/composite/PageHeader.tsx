import * as React from "react";
import { cn } from "../../lib/cn.ts";

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("flex items-center gap-4 border-b border-border px-6 py-3", className)}>
      <div className="min-w-0">
        <h1 className="text-base font-semibold leading-tight tracking-tight text-foreground truncate">{title}</h1>
        {description && <div className="mt-0.5 text-xs text-muted-foreground truncate">{description}</div>}
      </div>
      {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
    </header>
  );
}
