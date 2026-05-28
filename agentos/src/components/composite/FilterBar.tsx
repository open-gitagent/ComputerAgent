import * as React from "react";
import { cn } from "../../lib/cn.ts";

export function FilterBar({
  filters,
  actions,
  className,
}: {
  filters?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2 flex-wrap", className)}>
      <div className="flex items-center gap-2 flex-wrap">{filters}</div>
      {actions && <div className="ml-auto flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
