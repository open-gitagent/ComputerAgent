// Shared agents state. Lifted out of App so every route — the registry page
// and each agent dashboard — reads one fetch and one `reload`. A delete on the
// registry page therefore refreshes the same list the dashboard route sees.

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, type Agent } from "../api.ts";

interface AgentsState {
  agents: Agent[];
  loaded: boolean;
  err: string | null;
  reload: () => void;
}

const AgentsContext = createContext<AgentsState | null>(null);

export function AgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .agents()
      .then((a) => {
        setAgents(a);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <AgentsContext.Provider value={{ agents, loaded, err, reload }}>
      {children}
    </AgentsContext.Provider>
  );
}

export function useAgents(): AgentsState {
  const ctx = useContext(AgentsContext);
  if (!ctx) throw new Error("useAgents must be used within <AgentsProvider>");
  return ctx;
}
