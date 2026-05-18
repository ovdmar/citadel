import type {
  AgentRuntime,
  AgentSession,
  Operation,
  ProviderHealth,
  Repo,
  RuntimeUsageSummary,
  Workspace,
} from "@citadel/contracts";
import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Cable, CheckCircle2, HeartPulse, Settings, TerminalSquare, Trash2 } from "lucide-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { api, queryClient } from "./api.js";
import { type StateResponse, useStateQuery } from "./app-state.js";
import { Cockpit } from "./cockpit.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";
import { OnboardingView } from "./routes/onboarding.js";
import { OperationsView } from "./routes/operations.js";
import { RepoSettingsView } from "./routes/repo-settings.js";
import { StructuredConfig } from "./structured-config.js";
import "./styles.css";
import "./cockpit-extras.css";
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

const repoSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/repos/$repoId",
  component: RepoSettingsView,
});

const operationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/operations",
  component: OperationsView,
});

const onboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/onboarding",
  component: OnboardingView,
});

const router = createRouter({
  routeTree: rootRoute.addChildren([indexRoute, settingsRoute, repoSettingsRoute, operationsRoute, onboardingRoute]),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Shell() {
  return (
    <div className="app-root">
      <Outlet />
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
        <div className="settings-header-actions">
          <ThemeControls />
          <Link className="settings-link" to="/onboarding">
            Onboarding
          </Link>
          <Link className="settings-link" to="/operations">
            Operations
          </Link>
          <Link className="settings-link" to="/">
            Workspaces
          </Link>
        </div>
      </header>
      <div className="grid">
        <section className="panel wide">
          <PanelTitle icon={<Settings />} title="Local Config" />
          <StructuredConfig />
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
        <section className="panel wide">
          <PanelTitle icon={<Trash2 />} title="Repositories" />
          <RepositoryManagement state={state.data} />
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

function RepositoryManagement(props: { state: StateResponse | undefined }) {
  if (!props.state?.repos.length) return <div className="empty">No repositories registered</div>;
  return (
    <div className="repo-management">
      {props.state.repos.map((repo) => (
        <RepositoryRow
          key={repo.id}
          repo={repo}
          workspaces={props.state?.workspaces.filter((workspace) => workspace.repoId === repo.id) ?? []}
          sessions={props.state?.sessions ?? []}
          operations={props.state?.operations ?? []}
        />
      ))}
    </div>
  );
}

function RepositoryRow(props: {
  repo: Repo;
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
}) {
  const [confirming, setConfirming] = useState(false);
  const activeSessions = props.sessions.filter(
    (session) =>
      props.workspaces.some((workspace) => workspace.id === session.workspaceId) &&
      ["starting", "running", "waiting", "idle"].includes(session.status),
  ).length;
  const runningOperations = props.operations.filter(
    (operation) => operation.repoId === props.repo.id && ["queued", "running"].includes(operation.status),
  ).length;
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}${confirming ? "?force=true" : ""}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: () => setConfirming(true),
  });
  const needsConfirmation = activeSessions > 0 || runningOperations > 0;
  return (
    <div className="repo-row">
      <div>
        <strong>{props.repo.name}</strong>
        <span>{props.repo.rootPath}</span>
        <small>
          {props.workspaces.length} workspaces - {activeSessions} active sessions - {runningOperations} running
          operations
        </small>
      </div>
      <div className="repo-remove-controls">
        {confirming || needsConfirmation ? (
          <small>Removal preserves local repos/worktrees. Confirm when active work exists.</small>
        ) : null}
        <Link
          to="/repos/$repoId"
          params={{ repoId: props.repo.id }}
          className="settings-link"
          aria-label={`Open settings for ${props.repo.name}`}
        >
          Repo settings
        </Link>
        <Button
          type="button"
          className={confirming ? "danger-action" : undefined}
          variant={confirming ? "default" : "secondary"}
          onClick={() => remove.mutate()}
        >
          <Trash2 size={14} />
          {confirming ? "Confirm remove" : "Remove tracking"}
        </Button>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
