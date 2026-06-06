// Generic selector for the Observability views. Sources its options from the
// live `/v1/fields/:field/values` endpoint, which is RBAC-scoped server-side
// (ownerScopeFor) — so the dropdown lists exactly the values the caller may see
// for that field (agent name, owning group, actor, …). Empty value = no filter.

import { X } from "lucide-react";
import { obsApi } from "../../obs-api.ts";
import { Combobox, type ComboOption } from "../ui/combobox.tsx";
import { Button } from "../ui/button.tsx";

export function FieldValueFilter({
  field,
  value,
  onChange,
  placeholder,
  emptyMessage,
  width = "w-[180px]",
  clearLabel,
}: {
  /** Backend field key, e.g. "agent" | "group_id" | "actor_id". */
  field: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  emptyMessage: string;
  width?: string;
  clearLabel?: string;
}) {
  const loadOptions = (): Promise<ComboOption[]> =>
    obsApi
      .fieldValues(field, 100)
      .then((rows) => rows.map((r) => ({ value: r.value, count: r.count })));

  return (
    <div className="flex items-center gap-1">
      <Combobox
        value={value}
        onValueChange={onChange}
        loadOptions={loadOptions}
        loadOptionsKey={field}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        className={width}
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => onChange("")}
          aria-label={clearLabel ?? `Clear ${field} filter`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
