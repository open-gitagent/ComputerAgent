import { Plus, Trash2, Play } from "lucide-react";
import { FIELDS, OP_LABEL, fieldByKey, type Operator } from "../../obs-fields.ts";
import { obsApi, type Filter } from "../../obs-api.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.tsx";
import { Combobox, MultiCombobox, type ComboOption } from "../ui/combobox.tsx";

export function QueryBuilder({
  filters,
  onChange,
  onRun,
}: {
  filters: Filter[];
  onChange: (f: Filter[]) => void;
  onRun: () => void;
}) {
  const addFilter = () => {
    const first = FIELDS[0]!;
    onChange([...filters, { field: first.key, op: first.ops[0]!, value: "" }]);
  };
  const updateAt = (i: number, patch: Partial<Filter>) => {
    onChange(filters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  };
  const removeAt = (i: number) => onChange(filters.filter((_, idx) => idx !== i));

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Filters</span>
        <span className="text-[10px] text-muted-foreground/70">(AND)</span>
        <Button variant="ghost" size="sm" onClick={addFilter} className="ml-auto">
          <Plus className="h-3 w-3" />
          Add filter
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onChange([])} disabled={filters.length === 0}>
          Clear
        </Button>
        <Button variant="default" size="sm" onClick={onRun}>
          <Play className="h-3 w-3" />
          Run
        </Button>
      </div>
      {filters.length === 0 ? (
        <div className="text-xs text-muted-foreground py-1">No filters — showing recent traces in the selected window.</div>
      ) : (
        <div className="space-y-1.5">
          {filters.map((f, i) => (
            <FilterRow key={i} filter={f} onChange={(p) => updateAt(i, p)} onRemove={() => removeAt(i)} />
          ))}
        </div>
      )}
    </div>
  );
}

// Adapter — backend returns rich values, Combobox expects ComboOption[]
function loadFor(field: string): () => Promise<ComboOption[]> {
  return () =>
    obsApi.fieldValues(field, 100).then((rows) =>
      rows.map((r) => ({ value: r.value, count: r.count })),
    );
}

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: Filter;
  onChange: (p: Partial<Filter>) => void;
  onRemove: () => void;
}) {
  const field = fieldByKey(filter.field);
  const ops = field?.ops ?? [];

  const onFieldChange = (key: string) => {
    const next = fieldByKey(key);
    if (!next) return;
    const op: Operator = next.ops.includes(filter.op) ? filter.op : next.ops[0]!;
    onChange({ field: key, op, value: op === "in" || op === "not_in" ? [] : "" });
  };
  const onOpChange = (op: Operator) => {
    if (op === "in" || op === "not_in") {
      onChange({ op, value: Array.isArray(filter.value) ? filter.value : [] });
    } else if (op === "exists") {
      onChange({ op, value: undefined });
    } else {
      onChange({
        op,
        value: typeof filter.value === "string" || typeof filter.value === "number" ? filter.value : "",
      });
    }
  };

  const showValue = filter.op !== "exists";
  const isMulti = filter.op === "in" || filter.op === "not_in";
  const isNumber = field?.type === "number";
  const isContains = filter.op === "contains";

  return (
    <div className="flex items-center gap-1.5">
      <Select value={filter.field} onValueChange={onFieldChange}>
        <SelectTrigger className="h-8 w-[160px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FIELDS.map((f) => (
            <SelectItem key={f.key} value={f.key}>
              {f.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filter.op} onValueChange={(v) => onOpChange(v as Operator)}>
        <SelectTrigger className="h-8 w-[100px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ops.map((op) => (
            <SelectItem key={op} value={op}>
              {OP_LABEL[op]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {showValue && !isMulti && !isNumber && !isContains && (
        <Combobox
          value={String(filter.value ?? "")}
          onValueChange={(v) => onChange({ value: v })}
          loadOptions={loadFor(filter.field)}
          loadOptionsKey={filter.field}
          placeholder="Select value…"
          allowCustom
          className="flex-1"
        />
      )}

      {showValue && !isMulti && isNumber && (
        <Input
          type="number"
          value={String(filter.value ?? "")}
          onChange={(e) => onChange({ value: Number(e.target.value) })}
          placeholder="5000"
          className="h-8 flex-1 text-xs"
        />
      )}

      {showValue && !isMulti && isContains && (
        <Input
          type="text"
          value={String(filter.value ?? "")}
          onChange={(e) => onChange({ value: e.target.value })}
          placeholder="substring…"
          className="h-8 flex-1 text-xs"
        />
      )}

      {showValue && isMulti && (
        <MultiCombobox
          values={Array.isArray(filter.value) ? (filter.value as string[]) : []}
          onValuesChange={(vs) => onChange({ value: vs })}
          loadOptions={loadFor(filter.field)}
          loadOptionsKey={filter.field}
          placeholder="Pick values…"
          className="flex-1"
        />
      )}

      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="h-8 w-8 text-muted-foreground hover:text-destructive"
        aria-label="Remove filter"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
