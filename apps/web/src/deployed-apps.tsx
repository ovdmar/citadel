import type { DeployedApp, DeployedAppsSummary, Repo } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

export function DeployedAppsPanel(props: { workspaceId: string; repo: Repo | null }) {
  const summary = useQuery<DeployedAppsSummary>({
    queryKey: ["deployed-apps", props.workspaceId],
    queryFn: () => api<DeployedAppsSummary>(`/api/workspaces/${props.workspaceId}/deployed-apps`),
    refetchInterval: 10_000,
  });
  const redeploy = useMutation({
    mutationFn: (name?: string) =>
      api(`/api/workspaces/${props.workspaceId}/deployed-apps/redeploy`, {
        method: "POST",
        body: JSON.stringify(name ? { name } : {}),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deployed-apps", props.workspaceId] }),
  });

  const data = summary.data;
  const showEmpty = !data || data.resolution.source === "none";
  // Single-app panels only need the per-chip redeploy. The panel-level icon
  // (right-aligned next to the title) earns its place when there are 2+ apps.
  const showAllRedeploy = !showEmpty && (data?.apps.length ?? 0) >= 2;

  return (
    <section className="inspector-block">
      <div className="panel-title-row">
        <h4>Local deploys</h4>
        {showAllRedeploy ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={redeploy.isPending}
            onClick={() => redeploy.mutate(undefined)}
            title="Redeploy all apps"
            aria-label="Redeploy all apps"
          >
            <RefreshCw size={14} />
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
              redeploying={redeploy.isPending && redeploy.variables === app.name}
              onRedeploy={() => redeploy.mutate(app.name)}
            />
          ))}
        </div>
      ) : null}
      {showEmpty ? <DeployedAppsEmpty repo={props.repo} /> : null}
    </section>
  );
}

function DeployedAppChip(props: { app: DeployedApp; redeploying: boolean; onRedeploy: () => void }) {
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
        disabled={props.redeploying}
        title={`Redeploy ${app.name}`}
        aria-label={`Redeploy ${app.name}`}
      >
        <RefreshCw size={12} />
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
