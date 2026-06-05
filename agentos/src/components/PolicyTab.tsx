import { useEffect, useState } from "react";
import { api, type PolicyDoc, type AgentPolicyBinding } from "../api.ts";

/**
 * Per-agent policy attachment. Dropdown to bind one of the policies fetched
 * from SRS; "Detach" clears the binding. Bound policy is enforced inside
 * every chat sandbox the agent boots (see runtime SrsPolicyDecider).
 */
export function PolicyTab({
  agentId,
  agentLabel,
  onManagePolicies,
}: {
  agentId: string;
  agentLabel: string;
  onManagePolicies: () => void;
}) {
  const [policies, setPolicies] = useState<PolicyDoc[]>([]);
  const [binding, setBinding] = useState<AgentPolicyBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [pols, b] = await Promise.all([api.policies(), api.getAgentPolicy(agentId)]);
      setPolicies(pols);
      setBinding(b);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [agentId]);

  const attach = async (policyId: string | null) => {
    setSaving(true);
    try {
      const b = await api.setAgentPolicy(agentId, policyId);
      setBinding(b);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const boundPolicy = binding ? policies.find((p) => p._id === binding.policyId) : null;
  const guardrailSummary = (p: PolicyDoc): string => {
    const parts: string[] = [];
    if (p.cedar_guardrail?.enabled) parts.push(`Cedar (${p.cedar_guardrail.policies?.length ?? 0})`);
    if (p.opa_guardrail?.enabled) parts.push(`OPA (${p.opa_guardrail.managed_policies?.length ?? 0})`);
    return parts.length > 0 ? parts.join(" · ") : "all guardrails disabled";
  };

  return (
    <div className="p-6 max-w-3xl">
      <h2 className="text-lg font-semibold mb-1">Policy</h2>
      <p className="text-xs text-gray-500 mb-5">
        Attach one policy to {agentLabel}. The runtime enforces it via SRS on every tool call (Cedar &amp; OPA).
      </p>
      {err && <div className="mb-3 text-sm text-red-400">{err}</div>}

      <div className="rounded-lg border border-ink-600 bg-ink-800 p-4 mb-5">
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Attached</div>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : boundPolicy ? (
          <div>
            <div className="text-sm font-medium">{boundPolicy.name}</div>
            <div className="text-xs text-gray-500 mt-0.5">{boundPolicy.description || <em>no description</em>}</div>
            <div className="text-[11px] text-accent-soft mt-1">{guardrailSummary(boundPolicy)}</div>
            <button
              onClick={() => attach(null)}
              disabled={saving}
              className="mt-3 text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
            >
              Detach
            </button>
          </div>
        ) : binding ? (
          <div className="text-sm text-amber-400">
            Bound to <code className="font-mono text-xs">{binding.policyId}</code>, but it was deleted in SRS.
            <button onClick={() => attach(null)} className="ml-2 text-xs text-red-400">Detach</button>
          </div>
        ) : (
          <div className="text-sm text-gray-500">No policy attached — every tool call allowed.</div>
        )}
      </div>

      <div className="rounded-lg border border-ink-600 bg-ink-800 p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wide text-gray-500">Attach a policy</div>
          <button
            onClick={onManagePolicies}
            className="text-xs text-accent hover:text-accent-soft"
          >
            Manage policies →
          </button>
        </div>
        {policies.length === 0 ? (
          <div className="text-sm text-gray-500">
            No policies yet. <button onClick={onManagePolicies} className="text-accent hover:underline">Create one</button>.
          </div>
        ) : (
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {policies.map((p) => {
              const active = binding?.policyId === p._id;
              return (
                <button
                  key={p._id}
                  onClick={() => attach(p._id)}
                  disabled={saving || active}
                  className={`w-full text-left rounded-md px-3 py-2 transition ${
                    active ? "bg-accent/20 ring-1 ring-accent/40" : "hover:bg-ink-700"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {active && <span className="text-[10px] text-accent">ATTACHED</span>}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5 truncate">{p.description || <em>no description</em>}</div>
                  <div className="text-[10px] text-accent-soft mt-1">{guardrailSummary(p)}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
