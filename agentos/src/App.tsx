import { Home as HomeIcon, Activity, Shield, Boxes } from "lucide-react";
import { NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { HomePage } from "./components/HomePage.tsx";
import { PoliciesPage } from "./components/PoliciesPage.tsx";
import { ObservabilityTab } from "./components/observability/ObservabilityTab.tsx";
import { RegistryPage } from "./components/RegistryPage.tsx";
import { AgentDashboard } from "./components/AgentDashboard.tsx";
import { Separator } from "./components/ui/separator.tsx";
import { useAgents } from "./context/AgentsContext.tsx";
import { cn } from "./lib/cn.ts";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home" element={<HomeRoute />} />
        <Route path="registry" element={<RegistryRoute />} />
        <Route path="observability" element={<ObservabilityTab />} />
        <Route path="policies" element={<PoliciesPage />} />
        <Route path="agents/:name" element={<AgentDashboard />} />
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Route>
    </Routes>
  );
}

function Layout() {
  const { pathname } = useLocation();
  // "Agent Registry" stays active for both the registry list and any open agent.
  const registryActive = pathname.startsWith("/registry") || pathname.startsWith("/agents");

  return (
    <div className="flex h-full bg-background text-foreground">
      {/* Left rail */}
      <aside className="w-64 md:w-72 lg:w-80 shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <img src="/logos/agentos.png" alt="ComputerAgent" className="h-8 w-8 rounded-md object-contain" />
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">ComputerAgent</div>
              <div className="text-[11px] text-muted-foreground font-mono">Console</div>
            </div>
          </div>
        </div>

        <nav className="px-2 pt-2 space-y-1">
          <RailLink to="/home" icon={HomeIcon} label="Home" />
          <RailLink to="/registry" icon={Boxes} label="Agent Registry" active={registryActive} />
          <RailLink to="/observability" icon={Activity} label="Observability" />
          <RailLink to="/policies" icon={Shield} label="Policies" />
        </nav>

        <div className="flex-1" />

        <Separator />
        <div className="px-4 py-3 text-[10px] text-muted-foreground/70">agentos.clawagent.sh</div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        <Outlet />
      </main>
    </div>
  );
}

// ── Route wrappers — inject navigate-based callbacks so the page components
//    keep their existing prop contracts and need no router awareness. ──

function HomeRoute() {
  const { agents } = useAgents();
  const navigate = useNavigate();
  return (
    <HomePage
      agents={agents}
      onLaunch={(name, message) => navigate(`/agents/${encodeURIComponent(name)}`, { state: { message } })}
      onOpenDashboard={() => navigate(agents[0] ? `/agents/${encodeURIComponent(agents[0].name)}` : "/registry")}
    />
  );
}

function RegistryRoute() {
  const { agents, loaded, err, reload } = useAgents();
  const navigate = useNavigate();
  return (
    <RegistryPage
      agents={agents}
      loaded={loaded}
      err={err}
      selected={null}
      onOpenAgent={(name) => navigate(`/agents/${encodeURIComponent(name)}`)}
      onReload={reload}
    />
  );
}

function RailLink({
  to,
  icon: Icon,
  label,
  active,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  /** Optional override; defaults to react-router's own active match. */
  active?: boolean;
}) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        cn(
          "w-full text-left rounded-md px-3 py-2 text-sm transition-colors flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          (active ?? isActive)
            ? "bg-muted ring-1 ring-primary/40 text-foreground"
            : "hover:bg-muted/60 text-muted-foreground",
        )
      }
    >
      <Icon className="h-4 w-4" />
      <span>{label}</span>
    </NavLink>
  );
}
