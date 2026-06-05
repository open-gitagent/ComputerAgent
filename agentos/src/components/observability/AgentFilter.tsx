// Agent selector for the Observability views. Sources its options from the
// live `/v1/fields/agent/values` endpoint (FACET on gen_ai.agent.name), so it
// lists exactly the agents that have emitted telemetry. Empty value = all agents.

import { X } from "lucide-react";
import { obsApi } from "../../obs-api.ts";
import { Combobox, type ComboOption } from "../ui/combobox.tsx";
import { Button } from "../ui/button.tsx";

const loadAgents = (): Promise<ComboOption[]> =>
  obsApi
    .fieldValues("agent", 100)
    .then((rows) => rows.map((r) => ({ value: r.value, count: r.count })));

export function AgentFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Combobox
        value={value}
        onValueChange={onChange}
        loadOptions={loadAgents}
        loadOptionsKey="agent"
        placeholder="All agents"
        emptyMessage="No agents seen yet."
        className="w-[180px]"
      />
      {value && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={() => onChange("")}
          aria-label="Clear agent filter"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
