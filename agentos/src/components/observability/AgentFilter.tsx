// Agent selector for the Observability views. Thin wrapper over the generic
// FieldValueFilter, bound to the `agent` field (FACET on gen_ai.agent.name,
// RBAC-scoped server-side). Empty value = all agents.

import { FieldValueFilter } from "./FieldValueFilter.tsx";

export function AgentFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <FieldValueFilter
      field="agent"
      value={value}
      onChange={onChange}
      placeholder="All agents"
      emptyMessage="No agents seen yet."
      clearLabel="Clear agent filter"
    />
  );
}
