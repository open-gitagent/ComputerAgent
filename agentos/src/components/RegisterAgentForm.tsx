/**
 * Minimal "Register an agent" form. Surfaces the dashboard CRUD against the
 * Mongo `agent_registry` collection. Used for ops-driven registration (the
 * primary write path is the SDK's MongoTelemetry hook firing automatically
 * when a customer's worker imports `computeragent`).
 *
 * Three fields are required: name, harness, source. Everything else is
 * optional. The form upserts via POST /agentos/api/agents/register and
 * reports back the agent name on success.
 */
import { useState } from "react";
import { api, type RegisterAgentInput } from "../api.ts";

const HARNESS_OPTIONS = ["claude-agent-sdk", "gitagent", "deepagents"] as const;

export function RegisterAgentForm({ onRegistered }: { onRegistered?: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [harness, setHarness] = useState<string>(HARNESS_OPTIONS[0]);
  const [source, setSource] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const valid = name.trim().length > 0 && source.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const body: RegisterAgentInput = {
        name: name.trim(),
        harness,
        source: source.trim(),
      };
      if (label.trim()) body.label = label.trim();
      if (model.trim()) body.model = model.trim();
      const res = await api.registerAgent(body);
      setOk(`Registered "${res.name}"`);
      setName("");
      setLabel("");
      setSource("");
      setModel("");
      onRegistered?.(res.name);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs px-3 py-1.5 rounded-md bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
      >
        + Register agent
      </button>
    );
  }

  return (
    <div className="border border-ink-700 rounded-lg p-4 bg-ink-900 text-sm space-y-3">
      <div className="flex items-center justify-between">
        <div className="font-medium text-gray-200">Register an agent</div>
        <button
          onClick={() => {
            setOpen(false);
            setErr(null);
            setOk(null);
          }}
          className="text-gray-500 hover:text-gray-300"
        >
          ✕
        </button>
      </div>
      <p className="text-[11px] text-gray-500 leading-relaxed">
        Adds an agent to the Mongo <code>agent_registry</code> collection so the dashboard
        lists it. For library-mode deployments the SDK's <code>MongoTelemetry</code> hook
        registers automatically — use this only for ops-driven registration.
      </p>

      <Field
        label="Name"
        required
        value={name}
        onChange={setName}
        placeholder="devsupport-agent"
        autoFocus
      />
      <Field label="Label" value={label} onChange={setLabel} placeholder="DevSupport (optional)" />

      <div>
        <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
          Harness
        </label>
        <select
          value={harness}
          onChange={(e) => setHarness(e.target.value)}
          className="w-full bg-ink-800 border border-ink-700 rounded px-2 py-1.5 text-gray-200"
        >
          {HARNESS_OPTIONS.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
      </div>

      <Field
        label="Source"
        required
        value={source}
        onChange={setSource}
        placeholder="github.com/org/agent-repo"
      />
      <Field
        label="Model"
        value={model}
        onChange={setModel}
        placeholder="bedrock/anthropic.claude-sonnet-4-... (optional)"
      />

      {err && <div className="text-red-400 text-xs">{err}</div>}
      {ok && <div className="text-emerald-400 text-xs">{ok}</div>}

      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={() => setOpen(false)}
          className="text-xs px-3 py-1.5 text-gray-400 hover:text-gray-200"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!valid || busy}
          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white disabled:bg-ink-700 disabled:text-gray-500"
        >
          {busy ? "Registering…" : "Register"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  value,
  onChange,
  placeholder,
  autoFocus,
}: {
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1">
        {label}
        {required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      <input
        autoFocus={autoFocus}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ink-800 border border-ink-700 rounded px-2 py-1.5 text-gray-200 placeholder:text-gray-600"
      />
    </div>
  );
}
