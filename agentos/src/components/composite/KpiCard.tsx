import * as React from "react";
import { cn } from "../../lib/cn.ts";
import { Card } from "../ui/card.tsx";

export function KpiCard({
  label,
  value,
  subtitle,
  delta,
  children,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  subtitle?: React.ReactNode;
  delta?: { value: string; trend: "up" | "down" | "neutral" };
  children?: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("p-4 flex flex-col gap-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
          <div className="mt-1 text-xl font-semibold tracking-tight tabular-nums text-foreground truncate">
            {value}
          </div>
          {subtitle && <div className="mt-0.5 text-xs text-muted-foreground truncate">{subtitle}</div>}
        </div>
        {delta && (
          <span
            className={cn(
              "text-[10px] font-medium rounded px-1.5 py-0.5 tabular-nums shrink-0",
              delta.trend === "up" && "bg-success/15 text-success",
              delta.trend === "down" && "bg-destructive/15 text-destructive",
              delta.trend === "neutral" && "bg-muted text-muted-foreground",
            )}
          >
            {delta.value}
          </span>
        )}
      </div>
      {children && <div className="min-w-0">{children}</div>}
    </Card>
  );
}
