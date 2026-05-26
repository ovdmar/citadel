import type { DeployedApp, DeployedAppsSummary, Repo } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { api } from "./api.js";
import { Button } from "./components/ui/button.js";
import { useRedeploy } from "./hooks/use-redeploy.js";

export function DeployedAppsPanel(props: { workspaceId: string; repo: Repo | null }) {
  const summary = useQuery<DeployedAppsSummary>({
    queryKey: ["deployed-apps", props.workspaceId],
    queryFn: () => api<DeployedAppsSummary>(`/api/workspaces/${props.workspaceId}/deployed-apps`),
    refetchInterval: 10_000,
  });
  const redeploy = useRedeploy(props.workspaceId);

  const data = summary.data;
  const showEmpty = !data || data.resolution.source === "none";
  // Single-app panels only need the per-chip redeploy. The panel-level icon
  // (right-aligned next to the title) earns its place when there are 2+ apps.
  const showAllRedeploy = !showEmpty && (data?.apps.length ?? 0) >= 2;
  const allInFlight = redeploy.inFlight && redeploy.targetName === undefined;

  return (
    <section className="inspector-block">
      <div className="panel-title-row">
        <h4>Local deploys</h4>
        {showAllRedeploy ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={redeploy.inFlight}
            aria-busy={allInFlight}
            onClick={() => redeploy.trigger()}
            title="Redeploy all apps"
            aria-label="Redeploy all apps"
          >
            <RefreshCw size={14} className={allInFlight ? "animate-spin" : undefined} />
          </Button>
        ) : null}
      </div>
      {summary.isLoading ? <div className="empty compact">Probing deploy hook…</div> : null}
      {data?.resolution.note ? <output className="empty compact">{data.resolution.note}</output> : null}
      {data?.error ? <output className="empty compact">{data.error}</output> : null}
      {data?.apps.length ? (
        <div className="app-chip-grid">
          {data.apps.map((app) => (
            <DeployedAppChip
              key={app.name}
              app={app}
              disabled={redeploy.inFlight}
              redeploying={redeploy.inFlight && redeploy.targetName === app.name}
              onRedeploy={() => redeploy.trigger(app.name)}
            />
          ))}
        </div>
      ) : null}
      {redeploy.inFlight && redeploy.lastOperationId ? (
        <Link
          to="/operations"
          search={{ id: redeploy.lastOperationId }}
          className="settings-link"
          title="View the in-flight deploy operation log"
        >
          View log
        </Link>
      ) : null}
      {showEmpty ? <DeployedAppsEmpty repo={props.repo} /> : null}
    </section>
  );
}

function DeployedAppChip(props: {
  app: DeployedApp;
  disabled: boolean;
  redeploying: boolean;
  onRedeploy: () => void;
}) {
  const { app } = props;
  return (
    <div className={`app-chip tone-${chipTone(app.status)}`} title={`${app.name} · ${app.status} · ${app.url}`}>
      <span className="dot" />
      <a href={app.url} target="_blank" rel="noreferrer" className="app-chip-link">
        {app.name}
      </a>
      <button
        type="button"
        className="icon-button"
        onClick={props.onRedeploy}
        disabled={props.disabled}
        aria-busy={props.redeploying}
        title={`Redeploy ${app.name}`}
        aria-label={`Redeploy ${app.name}`}
      >
        <RefreshCw size={12} className={props.redeploying ? "animate-spin" : undefined} />
      </button>
    </div>
  );
}

// Binary indicator: green only when the probe succeeded, red otherwise (stopped
// or unknown). Yellow/degraded didn't communicate anything actionable.
function chipTone(status: DeployedApp["status"]) {
  return status === "deployed" ? "healthy" : "unavailable";
}

function DeployedAppsEmpty(props: { repo: Repo | null }) {
  return (
    <div className="empty-state-mock" aria-label="No deploy hook configured">
      <div className="empty-state-reason">
        <span>
          No deploy hook configured. Add an executable <code>.citadel/hooks/deploy</code> file at the worktree root, or
          set a deploy command in the repo settings.
        </span>
      </div>
      {props.repo ? (
        <Link
          to="/repos/$repoId"
          params={{ repoId: props.repo.id }}
          className="settings-link"
          title="Configure the deploy hook for this repo"
        >
          Configure deploy hook
        </Link>
      ) : null}
    </div>
  );
}
