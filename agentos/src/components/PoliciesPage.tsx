import { useEffect, useState } from "react";
import { api, type PolicyDoc, type CedarPolicyEntry, type OPAPolicyDoc } from "../api.ts";
import { useAuth } from "../context/AuthContext.tsx";

/**
 * Global Policies page. List on the left, editor on the right. Focuses on
 * Cedar + OPA — the two guardrails the ComputerAgent runtime actually
 * consults via /v1/guardrails/evaluate-tool-call. Other SRS guardrails
 * (PII, NSFW, topics, etc.) operate on LLM input text and aren't part of
 * the tool-call gate, so they're hidden here; manage them in SRS directly.
 */
export function PoliciesPage() {
  const { can } = useAuth();
  // RBAC (UX gating; server authorize() is the boundary). Policies have a
  // single write permission covering create / edit / delete.
  const canWrite = can("policies:write");
  const [policies, setPolicies] = useState<PolicyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<PolicyDoc | "new" | null>(null);

  const load = () => {
    setLoading(true);
    setErr(null);
    api.policies().then(setPolicies).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const onSaved = () => {
    setEditing(null);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this policy? Any agent bound to it will fall back to allow-all until rebound.")) return;
    try {
      await api.deletePolicy(id);
      if (editing && editing !== "new" && editing._id === id) setEditing(null);
      load();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="flex h-full">
      <div className="w-96 shrink-0 border-r border-ink-600 bg-ink-800 flex flex-col">
        <div className="px-5 py-4 border-b border-ink-600 flex items-center justify-between">
          <div>
            <div className="text-base font-semibold">Policies</div>
            <div className="text-[11px] text-gray-500">SRS-managed · Cedar + OPA</div>
          </div>
          {canWrite && (
            <button
              onClick={() => setEditing("new")}
              className="text-xs px-2.5 py-1 rounded bg-accent text-white hover:bg-accent/80"
            >
              + New
            </button>
          )}
        </div>
        {err && <div className="m-3 text-sm text-red-400">{err}</div>}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {loading && <div className="text-sm text-gray-500 p-2">Loading…</div>}
          {!loading && policies.length === 0 && (
            <div className="text-sm text-gray-500 p-2">
              No policies yet.{canWrite && <> Click <span className="text-accent">+ New</span>.</>}
            </div>
          )}
          {policies.map((p) => {
            const isActive = editing && editing !== "new" && editing._id === p._id;
            return (
              <button
                key={p._id}
                onClick={() => setEditing(p)}
                className={`w-full text-left rounded-md px-3 py-2 transition ${
                  isActive ? "bg-accent/20 ring-1 ring-accent/40" : "hover:bg-ink-700"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium truncate">{p.name}</span>
                  <span className="ml-auto text-[10px] text-gray-600 font-mono">{p._id.slice(-6)}</span>
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5 truncate">{p.description || <em>no description</em>}</div>
                <div className="text-[10px] text-accent-soft mt-1 flex gap-2">
                  {p.cedar_guardrail?.enabled && <span>Cedar ({p.cedar_guardrail.policies?.length ?? 0})</span>}
                  {p.opa_guardrail?.enabled && <span>OPA ({p.opa_guardrail.managed_policies?.length ?? 0})</span>}
                  {!p.cedar_guardrail?.enabled && !p.opa_guardrail?.enabled && <span className="text-gray-600">no guardrails enabled</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {editing === null ? (
          <div className="h-full grid place-items-center text-gray-600 text-sm">
            Select a policy{canWrite && (
              <> or <button onClick={() => setEditing("new")} className="text-accent hover:underline ml-1">create one</button></>
            )}.
          </div>
        ) : (
          <PolicyEditor
            initial={editing === "new" ? null : editing}
            canWrite={canWrite}
            onSaved={onSaved}
            onCancel={() => setEditing(null)}
            onDelete={editing === "new" || !canWrite ? undefined : () => remove(editing._id)}
          />
        )}
      </div>
    </div>
  );
}

interface EditorState {
  name: string;
  description: string;
  cedarEnabled: boolean;
  cedarFailOpen: boolean;
  cedarPolicies: CedarPolicyEntry[];
  opaEnabled: boolean;
  opaSource: "managed" | "external";
  opaManagedPolicyIds: string;     // comma-separated for the textarea
  opaServerUrl: string;
  opaPolicyPath: string;
  opaHook: "llm_input" | "llm_output" | "tool_input";   // stage the OPA binding runs at
  opaMode: "audit" | "enforce" | "fail_open" | "fail_closed";
  opaTimeoutSeconds: number;
}

const FRESH_CEDAR_RULE = (): CedarPolicyEntry => ({
  id: `rule_${Math.random().toString(36).slice(2, 8)}`,
  name: "Rule",
  description: "",
  policy_text: 'permit (\n  principal,\n  action,\n  resource\n);',
  enabled: true,
});

function PolicyEditor({
  initial,
  canWrite,
  onSaved,
  onCancel,
  onDelete,
}: {
  initial: PolicyDoc | null;
  canWrite: boolean;
  onSaved: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const [s, setS] = useState<EditorState>(() => ({
    name: initial?.name ?? "",
    description: initial?.description ?? "",
    cedarEnabled: initial?.cedar_guardrail?.enabled ?? false,
    cedarFailOpen: initial?.cedar_guardrail?.fail_open ?? false,
    cedarPolicies: initial?.cedar_guardrail?.policies ?? [],
    opaEnabled: initial?.opa_guardrail?.enabled ?? false,
    opaSource: initial?.opa_guardrail?.source ?? "managed",
    opaManagedPolicyIds: (initial?.opa_guardrail?.managed_policies ?? []).map((m) => m.policy_id).join(", "),
    opaServerUrl: initial?.opa_guardrail?.server_url ?? "",
    opaPolicyPath: initial?.opa_guardrail?.policy_path ?? "",
    opaHook:
      (initial?.opa_guardrail?.managed_policies?.[0]?.hooks?.[0] as EditorState["opaHook"]) ??
      (initial?.opa_guardrail?.external_hooks?.[0] as EditorState["opaHook"]) ??
      "tool_input",
    opaMode: initial?.opa_guardrail?.mode ?? "audit",
    opaTimeoutSeconds: initial?.opa_guardrail?.timeout_seconds ?? 5.0,
  }));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const upd = <K extends keyof EditorState>(k: K, v: EditorState[K]) => setS((p) => ({ ...p, [k]: v }));

  const updRule = (idx: number, patch: Partial<CedarPolicyEntry>) =>
    setS((p) => ({ ...p, cedarPolicies: p.cedarPolicies.map((r, i) => (i === idx ? { ...r, ...patch } : r)) }));
  const addRule = () => setS((p) => ({ ...p, cedarPolicies: [...p.cedarPolicies, FRESH_CEDAR_RULE()] }));
  const delRule = (idx: number) =>
    setS((p) => ({ ...p, cedarPolicies: p.cedarPolicies.filter((_, i) => i !== idx) }));

  const save = async () => {
    if (!s.name.trim()) {
      setErr("Name is required");
      return;
    }
    setSaving(true);
    setErr(null);
    const body: Partial<PolicyDoc> = {
      name: s.name.trim(),
      description: s.description.trim(),
      cedar_guardrail: {
        enabled: s.cedarEnabled,
        fail_open: s.cedarFailOpen,
        policies: s.cedarPolicies,
      },
      opa_guardrail: {
        enabled: s.opaEnabled,
        source: s.opaSource,
        managed_policies: s.opaManagedPolicyIds
          .split(",").map((x) => x.trim()).filter(Boolean)
          .map((policy_id) => ({ policy_id, hooks: [s.opaHook] })),
        server_url: s.opaServerUrl || null,
        policy_path: s.opaPolicyPath || null,
        external_hooks: [s.opaHook],
        mode: s.opaMode,
        timeout_seconds: s.opaTimeoutSeconds,
      },
    };
    try {
      if (initial) await api.updatePolicy(initial._id, body);
      else await api.createPolicy(body);
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <h2 className="text-lg font-semibold">{initial ? "Edit policy" : "Create policy"}</h2>
        {initial && (
          <div className="text-[11px] text-gray-500 font-mono">{initial._id}</div>
        )}
      </div>
      {err && <div className="mb-3 text-sm text-red-400">{err}</div>}

      <Section title="Identity">
        <Field label="Name">
          <input
            value={s.name}
            onChange={(e) => upd("name", e.target.value)}
            placeholder="e.g. production-tool-gate"
            className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm"
          />
        </Field>
        <Field label="Description">
          <textarea
            value={s.description}
            onChange={(e) => upd("description", e.target.value)}
            rows={2}
            placeholder="What this policy enforces and why."
            className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm"
          />
        </Field>
      </Section>

      <Section title="Cedar" right={<Toggle checked={s.cedarEnabled} onChange={(v) => upd("cedarEnabled", v)} />}>
        <p className="text-xs text-gray-500 mb-3">
          PARC policies: <code className="text-accent-soft">forbid (principal, action, resource);</code> denies every tool call.
          Each rule is a Cedar statement. <code className="text-accent-soft">forbid</code> wins over <code className="text-accent-soft">permit</code>.
        </p>
        <div className="space-y-3">
          {s.cedarPolicies.length === 0 && (
            <div className="text-xs text-gray-500 italic">No rules yet. Click "Add rule" to start.</div>
          )}
          {s.cedarPolicies.map((r, idx) => (
            <div key={r.id} className="rounded border border-ink-600 bg-ink-700 p-3">
              <div className="flex items-center gap-2 mb-2">
                <input
                  value={r.name ?? ""}
                  onChange={(e) => updRule(idx, { name: e.target.value })}
                  placeholder="Rule name"
                  className="bg-ink-800 border border-ink-600 rounded px-2 py-1 text-xs flex-1"
                />
                <Toggle small checked={r.enabled !== false} onChange={(v) => updRule(idx, { enabled: v })} />
                {canWrite && (
                  <button onClick={() => delRule(idx)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                )}
              </div>
              <textarea
                value={r.policy_text}
                onChange={(e) => updRule(idx, { policy_text: e.target.value })}
                rows={6}
                className="w-full bg-ink-800 border border-ink-600 rounded px-2 py-1.5 text-xs font-mono"
                placeholder="forbid (principal, action, resource);"
              />
            </div>
          ))}
          {canWrite && (
            <button
              onClick={addRule}
              className="text-xs px-2.5 py-1 rounded border border-ink-600 hover:bg-ink-700"
            >
              + Add rule
            </button>
          )}
        </div>
        <Field label="Fail-open on engine error" inline>
          <Toggle small checked={s.cedarFailOpen} onChange={(v) => upd("cedarFailOpen", v)} />
        </Field>
      </Section>

      <Section title="OPA" right={<Toggle checked={s.opaEnabled} onChange={(v) => upd("opaEnabled", v)} />}>
        <p className="text-xs text-gray-500 mb-3">
          Rego policies. <code className="text-accent-soft">managed</code> uses policies stored in SRS; <code className="text-accent-soft">external</code> hits your own OPA server.
        </p>
        <Field label="Source">
          <select
            value={s.opaSource}
            onChange={(e) => upd("opaSource", e.target.value as "managed" | "external")}
            className="bg-ink-700 border border-ink-600 rounded px-2 py-1 text-sm"
          >
            <option value="managed">managed (SRS-hosted)</option>
            <option value="external">external (your own OPA server)</option>
          </select>
        </Field>
        {s.opaSource === "managed" ? (
          <Field label="Managed policy IDs (comma-separated)">
            <ManagedPolicyPicker
              value={s.opaManagedPolicyIds}
              onChange={(v) => upd("opaManagedPolicyIds", v)}
              canWrite={canWrite}
            />
          </Field>
        ) : (
          <>
            <Field label="OPA server URL">
              <input
                value={s.opaServerUrl}
                onChange={(e) => upd("opaServerUrl", e.target.value)}
                placeholder="http://opa.internal:8181"
                className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm"
              />
            </Field>
            <Field label="Policy path">
              <input
                value={s.opaPolicyPath}
                onChange={(e) => upd("opaPolicyPath", e.target.value)}
                placeholder="/v1/data/tools/allow"
                className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm"
              />
            </Field>
          </>
        )}
        <Field label="Hook (stage)">
          <select
            value={s.opaHook}
            onChange={(e) => upd("opaHook", e.target.value as EditorState["opaHook"])}
            className="bg-ink-700 border border-ink-600 rounded px-2 py-1 text-sm"
          >
            <option value="tool_input">tool_input (gate tool calls)</option>
            <option value="llm_input">llm_input (evaluate on prompt)</option>
            <option value="llm_output">llm_output (evaluate on model output)</option>
          </select>
        </Field>
        <Field label="Mode">
          <select
            value={s.opaMode}
            onChange={(e) => upd("opaMode", e.target.value as EditorState["opaMode"])}
            className="bg-ink-700 border border-ink-600 rounded px-2 py-1 text-sm"
          >
            <option value="audit">audit (log denies but don't block)</option>
            <option value="enforce">enforce</option>
            <option value="fail_open">fail-open (allow on engine error)</option>
            <option value="fail_closed">fail-closed (deny on engine error)</option>
          </select>
        </Field>
        <Field label="Timeout (seconds)" inline>
          <input
            type="number"
            min={0.1}
            step={0.1}
            value={s.opaTimeoutSeconds}
            onChange={(e) => upd("opaTimeoutSeconds", Number(e.target.value))}
            className="bg-ink-700 border border-ink-600 rounded px-2 py-1 text-sm w-24"
          />
        </Field>
      </Section>

      <div className="mt-6 flex items-center gap-2">
        {canWrite && (
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 disabled:opacity-50"
          >
            {saving ? "Saving…" : initial ? "Save changes" : "Create policy"}
          </button>
        )}
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded border border-ink-600 text-sm hover:bg-ink-700"
        >
          {canWrite ? "Cancel" : "Close"}
        </button>
        {onDelete && (
          <button
            onClick={onDelete}
            className="ml-auto px-4 py-1.5 rounded border border-red-500/40 text-red-400 text-sm hover:bg-red-500/10"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Picker for OPA managed_policies. Renders the current comma-separated IDs
 * with chip-style display, a "Browse / create" button to open the modal,
 * and a free-text input fallback for direct ID entry.
 */
function ManagedPolicyPicker({ value, onChange, canWrite }: { value: string; onChange: (v: string) => void; canWrite: boolean }) {
  const [opaPolicies, setOpaPolicies] = useState<OPAPolicyDoc[] | null>(null);
  const [showModal, setShowModal] = useState(false);

  const refresh = () => api.opaPolicies().then(setOpaPolicies).catch(() => setOpaPolicies([]));
  useEffect(() => { refresh(); }, []);

  const selectedIds = value.split(",").map((s) => s.trim()).filter(Boolean);
  const byId = new Map((opaPolicies ?? []).map((p) => [p._id, p]));

  const toggle = (id: string) => {
    const has = selectedIds.includes(id);
    const next = has ? selectedIds.filter((x) => x !== id) : [...selectedIds, id];
    onChange(next.join(", "));
  };

  return (
    <>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="abc123, def456"
        className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm font-mono"
      />
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {selectedIds.map((id) => {
            const p = byId.get(id);
            return (
              <span key={id} className="text-[11px] rounded bg-accent/20 text-accent-soft px-2 py-0.5">
                {p ? p.name : <em>missing: {id.slice(0, 8)}…</em>}
              </span>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowModal(true)}
          className="text-xs px-2.5 py-1 rounded border border-ink-600 hover:bg-ink-700"
        >
          {canWrite ? "Browse / create Rego policies" : "Browse Rego policies"}
        </button>
        <span className="text-[11px] text-gray-500">
          {(opaPolicies?.length ?? 0)} available
        </span>
      </div>
      {showModal && (
        <RegoPoliciesModal
          selectedIds={selectedIds}
          onToggle={toggle}
          canWrite={canWrite}
          onClose={() => { setShowModal(false); refresh(); }}
        />
      )}
    </>
  );
}

/**
 * Modal for managing OPA rego policies stored in SRS (/v1/opa-policies).
 * Lists existing rego policies (with checkbox to bind into the parent RAI
 * policy), supports inline create + delete. The selection state lives in
 * the parent (PolicyEditor) — this modal just toggles via callbacks.
 */
function RegoPoliciesModal({
  selectedIds,
  onToggle,
  canWrite,
  onClose,
}: {
  selectedIds: string[];
  onToggle: (id: string) => void;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [policies, setPolicies] = useState<OPAPolicyDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newRego, setNewRego] = useState(
    'package main\n\n# Return a boolean or {allow: bool, reasons: [...]}.\n# Inputs available: input.request.tool_name, input.request.arguments,\n# input.metadata.principal_id, input.metadata.bundle_id.\n\ndefault allow := true\n\nallow := false {\n  input.request.tool_name == "Write"\n}\n',
  );

  const load = () => {
    setLoading(true); setErr(null);
    api.opaPolicies().then(setPolicies).catch((e) => setErr(String(e))).finally(() => setLoading(false));
  };
  useEffect(load, []);

  const create = async () => {
    if (!newName.trim() || !newRego.trim()) { setErr("Name and rego content are required"); return; }
    setCreating(true); setErr(null);
    try {
      await api.createOpaPolicy({ name: newName.trim(), description: newDesc.trim() || undefined, rego_content: newRego });
      setNewName(""); setNewDesc("");
      load();
    } catch (e) { setErr(String(e)); } finally { setCreating(false); }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this rego policy? Any RAI policy referencing it will fail to evaluate.")) return;
    try { await api.deleteOpaPolicy(id); load(); } catch (e) { setErr(String(e)); }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 grid place-items-center p-4">
      <div className="bg-ink-800 border border-ink-600 rounded-lg w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-5 py-3 border-b border-ink-600 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Rego policies</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200 text-sm">✕ Close</button>
        </div>
        {err && <div className="mx-5 mt-3 text-sm text-red-400">{err}</div>}

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Existing ({policies.length})</div>
            {loading ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : policies.length === 0 ? (
              <div className="text-sm text-gray-500 italic">None yet. Create one below.</div>
            ) : (
              <div className="space-y-1">
                {policies.map((p) => {
                  const selected = selectedIds.includes(p._id);
                  return (
                    <div key={p._id} className={`rounded border ${selected ? "border-accent/40 bg-accent/10" : "border-ink-600 bg-ink-700"} p-3`}>
                      <div className="flex items-center gap-2">
                        <input type="checkbox" checked={selected} onChange={() => onToggle(p._id)} />
                        <span className="text-sm font-medium">{p.name}</span>
                        <span className="text-[10px] text-gray-500 font-mono ml-auto">{p._id}</span>
                        {canWrite && (
                          <button onClick={() => remove(p._id)} className="text-xs text-red-400 hover:text-red-300">Delete</button>
                        )}
                      </div>
                      {p.description && <div className="text-[11px] text-gray-500 mt-0.5">{p.description}</div>}
                      <pre className="mt-2 text-[10px] font-mono bg-ink-800 border border-ink-600 rounded p-2 overflow-x-auto max-h-32">{p.rego_content}</pre>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {canWrite && (
            <div className="border-t border-ink-600 pt-4">
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-2">Create new</div>
              <div className="space-y-2">
                <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name (e.g. block-write)" className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm" />
                <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description (optional)" className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-sm" />
                <textarea value={newRego} onChange={(e) => setNewRego(e.target.value)} rows={10} className="w-full bg-ink-700 border border-ink-600 rounded px-3 py-1.5 text-xs font-mono" />
                <button onClick={create} disabled={creating} className="px-4 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80 disabled:opacity-50">
                  {creating ? "Creating…" : "Create"}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-ink-600 flex justify-end">
          <button onClick={onClose} className="px-4 py-1.5 rounded bg-accent text-white text-sm hover:bg-accent/80">Done</button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-5 rounded-lg border border-ink-600 bg-ink-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {right}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children, inline = false }: { label: string; children: React.ReactNode; inline?: boolean }) {
  return (
    <div className={inline ? "flex items-center gap-3" : ""}>
      <label className="block text-[11px] uppercase tracking-wide text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange, small = false }: { checked: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  const size = small ? "h-4 w-7" : "h-5 w-9";
  const dot = small ? "h-3 w-3" : "h-4 w-4";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`${size} relative rounded-full transition ${checked ? "bg-accent" : "bg-ink-600"}`}
    >
      <span
        className={`${dot} absolute top-0.5 ${checked ? (small ? "left-3" : "left-4") : "left-0.5"} bg-white rounded-full transition`}
      />
    </button>
  );
}
