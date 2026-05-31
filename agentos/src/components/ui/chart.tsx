// Minimal shadcn-style chart wrapper around recharts. Provides:
//   <ChartContainer config={{ key: { label, color } }}>
//     <LineChart>… recharts primitives …</LineChart>
//   </ChartContainer>
// and a tooltip body that auto-themes via CSS variables.

import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/cn.ts";

export type ChartConfig = Record<
  string,
  {
    label: React.ReactNode;
    color?: string;  // CSS color (hsl variable or literal)
    icon?: React.ComponentType<{ className?: string }>;
  }
>;

type ChartContextValue = { config: ChartConfig };
const ChartContext = React.createContext<ChartContextValue | null>(null);

export function useChart() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error("useChart() must be used inside <ChartContainer>");
  return ctx;
}

export const ChartContainer = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    config: ChartConfig;
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  }
>(({ id, className, children, config, ...props }, ref) => {
  const uniqueId = React.useId();
  const chartId = `chart-${(id ?? uniqueId).replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-chart={chartId}
        ref={ref}
        className={cn(
          "flex aspect-video justify-center text-xs",
          "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground",
          "[&_.recharts-cartesian-grid_line]:stroke-border/40",
          "[&_.recharts-curve.recharts-tooltip-cursor]:stroke-border",
          "[&_.recharts-dot]:stroke-transparent",
          "[&_.recharts-layer]:outline-none",
          "[&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border",
          "[&_.recharts-radial-bar-background-sector]:fill-muted",
          "[&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted/50",
          "[&_.recharts-reference-line_[stroke='#ccc']]:stroke-border",
          "[&_.recharts-sector[stroke='#fff']]:stroke-transparent",
          "[&_.recharts-sector]:outline-none",
          "[&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
});
ChartContainer.displayName = "ChartContainer";

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const entries = Object.entries(config).filter(([, v]) => v.color);
  if (entries.length === 0) return null;
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
[data-chart=${id}] {
${entries.map(([k, v]) => `  --color-${k}: ${v.color};`).join("\n")}
}
`,
      }}
    />
  );
}

// Re-export recharts primitives so screens don't import from two places.
export const ChartTooltip = RechartsPrimitive.Tooltip;
export const ChartLegend = RechartsPrimitive.Legend;

// Themed tooltip body. Pass via <ChartTooltip content={<ChartTooltipContent />} />.
// recharts forwards `active`, `payload`, `label` at render time — typed loosely
// because recharts 3.x's TooltipContentProps generics are awkward to satisfy.
export type ChartTooltipContentProps = {
  active?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload?: any[];
  label?: unknown;
  className?: string;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: "line" | "dot" | "dashed";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  labelFormatter?: (label: unknown, payload: any[]) => React.ReactNode;
  formatter?: (value: number | string | undefined, name: string) => React.ReactNode;
};

export const ChartTooltipContent = React.forwardRef<HTMLDivElement, ChartTooltipContentProps>(
  (
    {
      active,
      payload,
      className,
      hideLabel = false,
      hideIndicator = false,
      indicator = "dot",
      label,
      labelFormatter,
      formatter,
    },
    ref,
  ) => {
    const { config } = useChart();
    if (!active || !payload || payload.length === 0) return null;

    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md",
          className,
        )}
      >
        {!hideLabel && (
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {labelFormatter ? labelFormatter(label, payload) : String(label ?? "")}
          </div>
        )}
        <div className="grid gap-1">
          {payload.map((item: Record<string, unknown>, i: number) => {
            const key = String(item["dataKey"] ?? item["name"] ?? i);
            const cfg = config[key];
            const color = (item["color"] as string | undefined) ?? cfg?.color;
            const value = item["value"];
            return (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {!hideIndicator && (
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        indicator === "line" && "h-0.5 w-2 rounded-none",
                      )}
                      style={{ backgroundColor: color }}
                    />
                  )}
                  <span className="text-muted-foreground">{cfg?.label ?? String(item["name"] ?? "")}</span>
                </div>
                <span className="font-mono text-foreground tabular-nums">
                  {formatter
                    ? formatter(value as number | string | undefined, key)
                    : typeof value === "number"
                    ? value.toLocaleString()
                    : String(value ?? "")}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  },
);
ChartTooltipContent.displayName = "ChartTooltipContent";
