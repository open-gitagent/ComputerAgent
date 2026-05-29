/**
 * Minimal "Register an agent" form. Surfaces the dashboard CRUD against the
 * Mongo `agent_registry` collection.
 *
 * Only `name` is required — every other field is pre-filled with sensible
 * frontend defaults (claude-agent-sdk + general-agent repo + claude-sonnet-4-6).
 * Override via the Advanced toggle, or set VITE_AGENTOS_DEFAULT_* in
 * agentos/.env to ship different defaults.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { api, type RegisterAgentInput } from "../api.ts";
import { Button } from "./ui/button.tsx";

const HARNESS_OPTIONS = ["claude-agent-sdk", "gitagent", "deepagents"] as const;

// Sensible frontend defaults — overridable per-deployment via Vite env vars
// (only `VITE_*` prefixed vars are exposed to the bundle).
const DEFAULTS = {
  harness: (import.meta.env.VITE_AGENTOS_DEFAULT_HARNESS as string | undefined) ?? "claude-agent-sdk",
  source: (import.meta.env.VITE_AGENTOS_DEFAULT_SOURCE as string | undefined) ?? "github.com/shreyas-lyzr/general-agent",
  model: (import.meta.env.VITE_AGENTOS_DEFAULT_MODEL as string | undefined) ?? "claude-sonnet-4-6",
};

export function RegisterAgentForm({ onRegistered }: { onRegistered?: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [harness, setHarness] = useState<string>(DEFAULTS.harness);
  const [source, setSource] = useState(DEFAULTS.source);
  const [model, setModel] = useState(DEFAULTS.model);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  // Only `name` is strictly required client-side; defaults fill in the rest.
  const valid = name.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const body: RegisterAgentInput = {
        name: name.trim(),
        harness,
        source: source.trim() || DEFAULTS.source,
      };
      if (label.trim()) body.label = label.trim();
      if (model.trim()) body.model = model.trim();
      const res = await api.registerAgent(body);
      setOk(`Registered "${res.name}" — open it in the sidebar.`);
      setName("");
      setLabel("");
      // Keep source/model pre-filled so registering multiple agents in a row
      // doesn't make you re-type the same values.
      onRegistered?.(res.name);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button
        onClick={() => setOpen(true)}
        size="sm"
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm"
      >
        <Plus className="h-4 w-4" />
        Register agent
      </Button>
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
        Only a name is required. Defaults: <code>{DEFAULTS.harness}</code> on{" "}
        <code className="break-all">{DEFAULTS.source}</code>. Open Advanced to override.
      </p>

      <Field
        label="Name"
        required
        value={name}
        onChange={setName}
        placeholder="my-claude"
        autoFocus
      />
      <Field label="Label" value={label} onChange={setLabel} placeholder={name || "Display name (optional)"} />

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        className="text-[11px] text-gray-500 hover:text-gray-300"
      >
        {advanced ? "▾ Advanced" : "▸ Advanced (harness, source, model)"}
      </button>

      {advanced && (
        <div className="space-y-3 pt-1 border-t border-ink-800">
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
            value={source}
            onChange={setSource}
            placeholder={DEFAULTS.source}
          />
          <Field
            label="Model"
            value={model}
            onChange={setModel}
            placeholder={DEFAULTS.model}
          />
        </div>
      )}

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
