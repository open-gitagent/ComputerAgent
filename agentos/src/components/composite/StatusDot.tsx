import { cn } from "../../lib/cn.ts";

type Status = "live" | "idle" | "error" | "loading";

const STATUS_STYLE: Record<Status, { dot: string; ring?: string }> = {
  live: { dot: "bg-success", ring: "shadow-[0_0_0_3px_hsl(var(--success)/0.18)]" },
  idle: { dot: "bg-muted-foreground/50" },
  error: { dot: "bg-destructive" },
  loading: { dot: "bg-muted-foreground/50 animate-pulse" },
};

export function StatusDot({ status, label, className }: { status: Status; label?: string; className?: string }) {
  const s = STATUS_STYLE[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", className)}>
      <span className={cn("h-2 w-2 rounded-full shrink-0", s.dot, s.ring)} />
      {label && <span className="text-muted-foreground">{label}</span>}
    </span>
  );
}
