/**
 * "Register an agent" trigger + modal. The sidebar renders the button; clicking
 * it opens a dialog with the form. Surfaces the dashboard CRUD against the Mongo
 * `agent_registry` collection.
 *
 * Only `name` is required — every other field is pre-filled with sensible
 * frontend defaults (claude-agent-sdk + general-agent repo + claude-haiku-4-5).
 * Override via the Advanced toggle, or set VITE_AGENTOS_DEFAULT_* in
 * agentos/.env to ship different defaults.
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { api, type RegisterAgentInput } from "../api.ts";
import { Button } from "./ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "./ui/dialog.tsx";

const HARNESS_OPTIONS = ["claude-agent-sdk", "gitagent", "deepagents"] as const;

// Sensible frontend defaults — overridable per-deployment via Vite env vars
// (only `VITE_*` prefixed vars are exposed to the bundle).
const DEFAULTS = {
  harness: (import.meta.env.VITE_AGENTOS_DEFAULT_HARNESS as string | undefined) ?? "claude-agent-sdk",
  source: (import.meta.env.VITE_AGENTOS_DEFAULT_SOURCE as string | undefined) ?? "github.com/shreyas-lyzr/general-agent",
  model: (import.meta.env.VITE_AGENTOS_DEFAULT_MODEL as string | undefined) ?? "claude-haiku-4-5",
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
      // Action done → close the modal and confirm via toast. Reset the fields
      // so the next open starts clean.
      toast.success(`Registered "${res.name}"`);
      setName("");
      setLabel("");
      setErr(null);
      setOk(null);
      onRegistered?.(res.name);
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setErr(null);
          setOk(null);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm">
          <Plus className="h-4 w-4" />
          Register agent
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Register an agent</DialogTitle>
          <DialogDescription>
            Only a name is required
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Field label="Name" required value={name} onChange={setName} placeholder="my-claude" autoFocus />
          <Field label="Label" value={label} onChange={setLabel} placeholder={name || "Display name (optional)"} />

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="text-[11px] text-muted-foreground hover:text-foreground"
          >
            {advanced ? "▾ Advanced" : "▸ Advanced (harness, source, model)"}
          </button>

          {advanced && (
            <div className="space-y-3 pt-1 border-t border-border">
              <div>
                <label className="block text-[11px] uppercase tracking-wider text-muted-foreground mb-1">Harness</label>
                <select
                  value={harness}
                  onChange={(e) => setHarness(e.target.value)}
                  className="w-full bg-background border border-border rounded px-2 py-1.5 text-foreground text-sm"
                >
                  {HARNESS_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>

              <Field label="Source" value={source} onChange={setSource} placeholder={DEFAULTS.source} />
              <Field label="Model" value={model} onChange={setModel} placeholder={DEFAULTS.model} />
            </div>
          )}

          {err && <div className="text-destructive text-xs">{err}</div>}
          {ok && <div className="text-emerald-400 text-xs">{ok}</div>}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              Close
            </Button>
          </DialogClose>
          <Button size="sm" onClick={submit} disabled={!valid || busy}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
      <label className="block text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      <input
        autoFocus={autoFocus}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-background border border-border rounded px-2 py-1.5 text-foreground text-sm placeholder:text-muted-foreground/60"
      />
    </div>
  );
}
