import type { AgentRuntime, ProviderHealth, RuntimeUsageSummary } from "@citadel/contracts";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Boxes, Cable, CheckCircle2, HeartPulse, Settings, TerminalSquare } from "lucide-react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { api, queryClient } from "./api.js";
import { type StateResponse, useStateQuery } from "./app-state.js";
import { Cockpit } from "./cockpit.js";
import { Badge } from "./components/ui/badge.js";
import { ConfigForm } from "./config-form.js";
import { formatLabel } from "./labels.js";
import "./styles.css";
import "./cockpit-tools.css";
import "./settings.css";
import "./responsive.css";
import { ThemeControls } from "./theme-controls.js";

const rootRoute = createRootRoute({
  component: () => <Shell />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Cockpit,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, settingsRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Shell() {
  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">Citadel</div>
        <nav>
          <Link to="/" activeProps={{ className: "active" }}>
            <Boxes size={17} /> Workspaces
          </Link>
          <Link to="/settings" activeProps={{ className: "active" }}>
            <Settings size={17} /> Settings
          </Link>
        </nav>
        <ThemeControls />
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function SettingsView() {
  const state = useStateQuery();
  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Settings</h1>
          <p>Config, providers, runtimes, MCP, and local-first health.</p>
        </div>
      </header>
      <div className="grid">
        <section className="panel wide">
          <PanelTitle icon={<Settings />} title="Local Config" />
          <ConfigForm />
        </section>
        <section className="panel">
          <PanelTitle icon={<CheckCircle2 />} title="Setup Status" />
          <SetupStatus state={state.data} />
        </section>
        <section className="panel">
          <PanelTitle icon={<HeartPulse />} title="Providers" />
          {state.data?.providerHealth.map((provider) => (
            <HealthRow key={provider.id} provider={provider} />
          ))}
        </section>
        <section className="panel">
          <PanelTitle icon={<TerminalSquare />} title="Runtimes" />
          {state.data?.runtimes.map((runtime) => (
            <div key={runtime.id} className="runtime-row">
              <HealthRow
                provider={{
                  id: runtime.id,
                  displayName: runtime.displayName,
                  kind: "usage",
                  status: runtime.health,
                  reason: runtime.healthReason,
                  checkedAt: new Date().toISOString(),
                }}
              />
              <RuntimeUsage runtime={runtime} />
            </div>
          ))}
        </section>
        <section className="panel">
          <PanelTitle icon={<Cable />} title="MCP" />
          <div className="empty">{state.data?.mcp.enabled ? "Enabled for local/internal use" : "Disabled"}</div>
        </section>
      </div>
    </div>
  );
}

function PanelTitle(props: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {props.icon}
      <h2>{props.title}</h2>
    </div>
  );
}

function HealthRow(props: { provider: ProviderHealth }) {
  return (
    <div className={`health ${props.provider.status}`}>
      <strong>{props.provider.displayName}</strong>
      <span>{formatLabel(props.provider.status)}</span>
      {props.provider.reason ? <p>{props.provider.reason}</p> : null}
    </div>
  );
}

function RuntimeUsage(props: { runtime: AgentRuntime }) {
  const usage = useQuery({
    queryKey: ["runtime-usage", props.runtime.id],
    queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${props.runtime.id}/usage`),
  });
  const summary = usage.data?.usage;
  if (!summary) return <div className="usage-row">Usage unavailable</div>;
  return (
    <div className={`usage-row ${summary.status}`}>
      <span>{summary.source}</span>
      <strong>{summary.remaining ?? summary.spend ?? formatLabel(summary.status)}</strong>
      {summary.reason ? <p>{summary.reason}</p> : null}
    </div>
  );
}

function SetupStatus(props: { state: StateResponse | undefined }) {
  const healthyProviders = props.state?.providerHealth.filter((provider) => provider.status === "healthy").length ?? 0;
  const totalProviders = props.state?.providerHealth.length ?? 0;
  const healthyRuntimes = props.state?.runtimes.filter((runtime) => runtime.health === "healthy").length ?? 0;
  return (
    <div className="setup-list">
      <SetupRow label="Config file" status="Ready" ready />
      <SetupRow
        label="Providers"
        status={`${healthyProviders}/${totalProviders} healthy`}
        ready={healthyProviders > 0}
      />
      <SetupRow label="Runtimes" status={`${healthyRuntimes} available`} ready={healthyRuntimes > 0} />
      <SetupRow
        label="Repos"
        status={`${props.state?.repos.length ?? 0} registered`}
        ready={(props.state?.repos.length ?? 0) > 0}
      />
    </div>
  );
}

function SetupRow(props: { label: string; status: string; ready: boolean }) {
  return (
    <div className={`setup-row ${props.ready ? "ready" : "pending"}`}>
      <strong>{props.label}</strong>
      <Badge variant={props.ready ? "ready" : "blocked"}>{props.status}</Badge>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
