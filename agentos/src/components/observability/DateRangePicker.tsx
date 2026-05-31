import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group.tsx";

export type Range = { from: string; to: string };

const PRESETS = [
  { label: "15m", from: "now-15m" },
  { label: "1h", from: "now-1h" },
  { label: "6h", from: "now-6h" },
  { label: "24h", from: "now-24h" },
  { label: "72h", from: "now-72h" },
] as const;

export function DateRangePicker({ value, onChange }: { value: Range; onChange: (r: Range) => void }) {
  const active = value.to === "now" ? value.from : "";
  return (
    <ToggleGroup
      type="single"
      value={active}
      onValueChange={(v) => v && onChange({ from: v, to: "now" })}
      aria-label="Time range"
    >
      {PRESETS.map((p) => (
        <ToggleGroupItem key={p.label} value={p.from} size="sm">
          {p.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
