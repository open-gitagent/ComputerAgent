// Combobox (single + multi-select). Built on Popover + Command (cmdk).
//
// Both variants lazy-load their options via `loadOptions()` the first time
// the popover opens, and cache the result for the lifetime of the component.
// `loadOptionsKey` invalidates the cache when changed (e.g., field switch in
// the QueryBuilder).

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "../../lib/cn.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./command.tsx";
import { Button } from "./button.tsx";
import { Badge } from "./badge.tsx";

export type ComboOption = {
  value: string;
  label?: string;
  count?: number;
};

function useLoadOptions(loadOptions: () => Promise<ComboOption[]>, key: string) {
  const [options, setOptions] = React.useState<ComboOption[]>([]);
  const [loading, setLoading] = React.useState(false);
  const loadedKeyRef = React.useRef<string | null>(null);

  const load = React.useCallback(() => {
    if (loadedKeyRef.current === key) return;
    loadedKeyRef.current = key;
    setLoading(true);
    loadOptions()
      .then(setOptions)
      .catch(() => setOptions([]))
      .finally(() => setLoading(false));
  }, [loadOptions, key]);

  // Reset cache when key changes
  React.useEffect(() => {
    loadedKeyRef.current = null;
  }, [key]);

  return { options, loading, load };
}

function OptionRow({
  option,
  selected,
  onSelect,
}: {
  option: ComboOption;
  selected: boolean;
  onSelect: (v: string) => void;
}) {
  return (
    <CommandItem value={option.value} onSelect={() => onSelect(option.value)}>
      <Check className={cn("mr-2 h-3.5 w-3.5", selected ? "opacity-100" : "opacity-0")} />
      <span className="flex-1 truncate">{option.label ?? option.value}</span>
      {typeof option.count === "number" && option.count > 0 && (
        <span className="ml-2 text-[10px] text-muted-foreground tabular-nums">
          {option.count.toLocaleString()}
        </span>
      )}
    </CommandItem>
  );
}

// ---------------------------------------------------------------------------
// Single-value Combobox
// ---------------------------------------------------------------------------

export function Combobox({
  value,
  onValueChange,
  loadOptions,
  loadOptionsKey = "default",
  placeholder = "Select…",
  emptyMessage = "No values yet.",
  allowCustom = false,
  className,
}: {
  value: string;
  onValueChange: (v: string) => void;
  loadOptions: () => Promise<ComboOption[]>;
  loadOptionsKey?: string;
  placeholder?: string;
  emptyMessage?: string;
  allowCustom?: boolean;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const { options, loading, load } = useLoadOptions(loadOptions, loadOptionsKey);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const select = (v: string) => {
    onValueChange(v);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-8 justify-between font-normal text-xs", className)}
        >
          <span className={cn("truncate", !value && "text-muted-foreground")}>
            {value || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" value={search} onValueChange={setSearch} />
          <CommandList>
            {loading ? (
              <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
            ) : (
              <>
                <CommandEmpty>
                  {allowCustom && search ? (
                    <button
                      type="button"
                      onClick={() => select(search)}
                      className="block w-full px-2 py-1.5 text-left text-sm hover:bg-accent rounded"
                    >
                      Use “{search}”
                    </button>
                  ) : (
                    emptyMessage
                  )}
                </CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <OptionRow
                      key={o.value}
                      option={o}
                      selected={value === o.value}
                      onSelect={select}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Multi-value Combobox — chips inside the trigger, popover stays open between
// selections so users can pick several at once.
// ---------------------------------------------------------------------------

export function MultiCombobox({
  values,
  onValuesChange,
  loadOptions,
  loadOptionsKey = "default",
  placeholder = "Select…",
  emptyMessage = "No values yet.",
  className,
}: {
  values: string[];
  onValuesChange: (vs: string[]) => void;
  loadOptions: () => Promise<ComboOption[]>;
  loadOptionsKey?: string;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const { options, loading, load } = useLoadOptions(loadOptions, loadOptionsKey);

  React.useEffect(() => {
    if (open) load();
  }, [open, load]);

  const toggle = (v: string) => {
    if (values.includes(v)) onValuesChange(values.filter((x) => x !== v));
    else onValuesChange([...values, v]);
  };

  const remove = (v: string) => onValuesChange(values.filter((x) => x !== v));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            "h-auto min-h-8 justify-between font-normal text-xs py-1 px-2 flex-wrap gap-1",
            className,
          )}
        >
          <div className="flex flex-wrap items-center gap-1 flex-1 min-w-0">
            {values.length === 0 && <span className="text-muted-foreground">{placeholder}</span>}
            {values.map((v) => (
              <Badge key={v} variant="secondary" className="gap-1 text-[11px]">
                {v}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(v);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" value={search} onValueChange={setSearch} />
          <CommandList>
            {loading ? (
              <div className="py-4 text-center text-xs text-muted-foreground">Loading…</div>
            ) : (
              <>
                <CommandEmpty>{emptyMessage}</CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <OptionRow
                      key={o.value}
                      option={o}
                      selected={values.includes(o.value)}
                      onSelect={toggle}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
