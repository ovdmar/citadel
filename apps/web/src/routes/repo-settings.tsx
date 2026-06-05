import type { HookDiagnostic, Repo } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowLeft, RefreshCcw, Save, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "../api.js";
import { useStateQuery } from "../app-state.js";
import { Button } from "../components/ui/button.js";
import { formatLabel } from "../labels.js";

type ScaffoldHookResponse = {
  workspaceId: string;
  sessionId: string | null;
  branchName: string;
  workspacePath: string;
  operationId: string | null;
  reused: boolean;
};

// Reach the daemon's POST /api/repos/:repoId/scaffold-hook with the standard
// api() wrapper. Returns the spawned (or reused) workspace + session so the
// cockpit can navigate the operator to the agent's terminal.
function useScaffoldHook(repoId: string) {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api<ScaffoldHookResponse>(`/api/repos/${repoId}/scaffold-hook`, { method: "POST" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["state"] });
      navigate({ to: "/" });
    },
  });
}

// Detect an in-flight hook-scaffold-* workspace for this repo (driven by app
// state, not a separate endpoint — workspaces are already in the cockpit's
// state snapshot). Used both to disable the empty-state button and to render
// a banner at the top of the page.
function useInFlightScaffold(repoId: string) {
  const state = useStateQuery();
  const workspaces = state.data?.workspaces ?? [];
  return workspaces.find(
    (ws) => ws.repoId === repoId && ws.lifecycle === "ready" && ws.branch.startsWith("hook-scaffold-"),
  );
}

export function RepoSettingsView() {
  const params = useParams({ strict: false }) as { repoId?: string };
  const repoId = params.repoId ?? "";
  const state = useStateQuery();
  const repo = state.data?.repos.find((candidate) => candidate.id === repoId);
  if (!repo) {
    return (
      <div className="page">
        <header className="header">
          <h1>Repository not found</h1>
          <Link to="/settings" className="settings-link">
            <ArrowLeft size={14} /> Back to settings
          </Link>
        </header>
      </div>
    );
  }
  return (
    <div className="page repo-settings">
      <header className="header">
        <div>
          <h1>{repo.name}</h1>
          <p>{repo.rootPath}</p>
        </div>
        <div className="settings-header-actions">
          <Link className="settings-link" to="/settings">
            <ArrowLeft size={14} /> Back
          </Link>
          <Link className="settings-link" to="/">
            Workspaces
          </Link>
        </div>
      </header>
      <ScaffoldInFlightBanner repoId={repo.id} />
      <div className="grid">
        <RepoIdentitySection repo={repo} />
        <RepoHooksSection repo={repo} />
        <RepoDeployHookSection repo={repo} />
        <RepoProvidersSection repo={repo} />
        <RepoActionsSection repo={repo} />
      </div>
    </div>
  );
}

function ScaffoldInFlightBanner(props: { repoId: string }) {
  const inFlight = useInFlightScaffold(props.repoId);
  if (!inFlight) return null;
  return (
    <div className="scaffold-banner">
      <Sparkles size={14} />
      <span>
        Hook scaffold session in-flight on branch <code>{inFlight.branch}</code>.
      </span>
      <Link to="/" className="settings-link">
        Open workspace
      </Link>
    </div>
  );
}

function RepoIdentitySection(props: { repo: Repo }) {
  const [name, setName] = useState(props.repo.name);
  const [worktreeParent, setWorktreeParent] = useState(props.repo.worktreeParent);
  const [showMainWorkspace, setShowMainWorkspace] = useState(props.repo.showMainWorkspace === true);
  useEffect(() => {
    setName(props.repo.name);
    setWorktreeParent(props.repo.worktreeParent);
    setShowMainWorkspace(props.repo.showMainWorkspace === true);
  }, [props.repo.name, props.repo.worktreeParent, props.repo.showMainWorkspace]);
  const mutation = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, worktreeParent, showMainWorkspace }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  return (
    <section className="panel wide">
      <h2>Identity</h2>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <label>
          Display name
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          Worktree parent
          <input value={worktreeParent} onChange={(event) => setWorktreeParent(event.target.value)} />
        </label>
        <label>
          Root path (read-only)
          <input value={props.repo.rootPath} readOnly />
        </label>
        <label>
          Default branch (read-only)
          <input value={props.repo.defaultBranch} readOnly />
        </label>
        <label className="repo-main-workspace-toggle">
          <input
            type="checkbox"
            checked={showMainWorkspace}
            onChange={(event) => setShowMainWorkspace(event.currentTarget.checked)}
          />
          <span>Show main repo location in navigation</span>
        </label>
        <Button type="submit" disabled={mutation.isPending}>
          <Save size={14} /> Save identity
        </Button>
        {mutation.error ? <p>{String(mutation.error)}</p> : null}
      </form>
    </section>
  );
}

function RepoHooksSection(props: { repo: Repo }) {
  const diagnostics = useQuery({
    queryKey: ["hook-diagnostics", props.repo.id],
    queryFn: () =>
      api<{ diagnostics: HookDiagnostic[]; sample: unknown }>(`/api/repos/${props.repo.id}/hook-diagnostics`),
  });
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ config: { hooks: Array<{ id: string; event: string }> } }>("/api/config"),
  });
  const [setupIds, setSetupIds] = useState(props.repo.setupHookIds.join(", "));
  const [teardownIds, setTeardownIds] = useState(props.repo.teardownHookIds.join(", "));
  useEffect(() => {
    setSetupIds(props.repo.setupHookIds.join(", "));
    setTeardownIds(props.repo.teardownHookIds.join(", "));
  }, [props.repo.setupHookIds, props.repo.teardownHookIds]);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          setupHookIds: split(setupIds),
          teardownHookIds: split(teardownIds),
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const knownHooks = config.data?.config.hooks ?? [];
  return (
    <section className="panel wide">
      <div className="panel-title-row">
        <h2>Hooks</h2>
        <Button type="button" variant="ghost" size="icon" onClick={() => diagnostics.refetch()}>
          <RefreshCcw size={14} />
        </Button>
      </div>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <label>
          Setup hook IDs (comma-separated)
          <input value={setupIds} onChange={(event) => setSetupIds(event.target.value)} />
        </label>
        <label>
          Teardown hook IDs (comma-separated)
          <input value={teardownIds} onChange={(event) => setTeardownIds(event.target.value)} />
        </label>
        <small>
          Available hook IDs in config:{" "}
          {knownHooks.length ? knownHooks.map((h) => `${h.id} (${h.event})`).join(", ") : "(none defined)"}
        </small>
        <Button type="submit" disabled={save.isPending}>
          <Save size={14} /> Save hook bindings
        </Button>
      </form>
      <div className="hook-diagnostics">
        {(diagnostics.data?.diagnostics ?? []).map((hook) => (
          <details key={`${hook.event}-${hook.hookId}`} className={`hook-row ${hook.validationStatus}`}>
            <summary>
              <strong>{hook.hookId}</strong>
              <span>{hook.event}</span>
              <em>{hook.validationStatus}</em>
            </summary>
            <div className="hook-grid">
              <KeyValue label="Command" value={[hook.command, ...hook.args].join(" ")} />
              <KeyValue label="CWD" value={hook.cwd ?? "workspace"} />
              <KeyValue label="Blocking" value={hook.blocking ? "yes" : "no"} />
              <KeyValue label="Last run" value={hook.lastRunAt ?? "not run"} />
            </div>
            {hook.validationErrors.length ? <pre>{hook.validationErrors.join("\n")}</pre> : null}
          </details>
        ))}
        {diagnostics.data && !diagnostics.data.diagnostics.length ? <NoHooksEmptyState repoId={props.repo.id} /> : null}
      </div>
    </section>
  );
}

function NoHooksEmptyState(props: { repoId: string }) {
  const inFlight = useInFlightScaffold(props.repoId);
  const scaffold = useScaffoldHook(props.repoId);
  return (
    <div className="empty compact scaffold-empty">
      <div>No hooks bound to this repo.</div>
      <Button type="button" variant="secondary" onClick={() => scaffold.mutate()} disabled={scaffold.isPending}>
        <Sparkles size={14} />
        {inFlight ? "Resume scaffold session" : "Scaffold with AI"}
      </Button>
      {scaffold.error ? <div className="form-error">{String(scaffold.error)}</div> : null}
    </div>
  );
}

function RepoDeployHookSection(props: { repo: Repo }) {
  const [command, setCommand] = useState(props.repo.deployHookCommand ?? "");
  useEffect(() => setCommand(props.repo.deployHookCommand ?? ""), [props.repo.deployHookCommand]);
  const save = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ deployHookCommand: command.trim() ? command : null }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const mainExample = `${props.repo.rootPath.replace(/\/$/, "")}/.citadel/hooks/deploy`;
  return (
    <section className="panel wide">
      <h2>Deploy hook</h2>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <p className="settings-hint">
          Citadel resolves the deploy hook per-worktree. The repo-static file at <code>.citadel/hooks/deploy</code>{" "}
          takes priority; this command runs as a fallback. The hook is invoked with <code>$1=list|redeploy</code> and{" "}
          <code>$2=app-name</code>, cwd = the worktree path, and env <code>CITADEL_WORKSPACE_ID</code>,{" "}
          <code>CITADEL_WORKSPACE_PATH</code>, <code>CITADEL_WORKSPACE_BRANCH</code>, <code>CITADEL_REPO_ID</code>.
        </p>
        <label>
          Deploy command (bash)
          <textarea
            rows={6}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder={
              'case "$1" in\n  list) jq -n \'{apps:[{name:"web",url:"http://localhost:3000"}]}\' ;;\n  redeploy) make dev-deploy "$2" ;;\nesac'
            }
            spellCheck={false}
          />
        </label>
        <small>
          Highest priority is the file <code>&lt;your-worktree&gt;/.citadel/hooks/deploy</code> (must be executable).
          For the main checkout, that resolves to <code>{mainExample}</code>; each worktree gets its own copy.
        </small>
        <Button type="submit" disabled={save.isPending}>
          <Save size={14} /> Save deploy command
        </Button>
        {save.error ? <p className="form-error">{String(save.error)}</p> : null}
      </form>
    </section>
  );
}

function RepoProvidersSection(props: { repo: Repo }) {
  const [active, setActive] = useState(props.repo.providerIds);
  useEffect(() => setActive(props.repo.providerIds), [props.repo.providerIds]);
  const known = [
    { id: "github-gh", displayName: "GitHub CLI" },
    { id: "jira-jtk", displayName: "Jira CLI" },
  ];
  const save = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}`, {
        method: "PATCH",
        body: JSON.stringify({ providerIds: active }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  return (
    <section className="panel">
      <h2>Providers</h2>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        {known.map((provider) => (
          <label key={provider.id}>
            <input
              type="checkbox"
              checked={active.includes(provider.id)}
              onChange={(event) =>
                setActive((current) =>
                  event.target.checked ? [...current, provider.id] : current.filter((id) => id !== provider.id),
                )
              }
            />
            {provider.displayName}
          </label>
        ))}
        <Button type="submit" disabled={save.isPending}>
          <Save size={14} /> Save providers
        </Button>
      </form>
    </section>
  );
}

function RepoActionsSection(props: { repo: Repo }) {
  const refresh = useMutation({
    mutationFn: () => api(`/api/repos/${props.repo.id}/refresh`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const remove = useMutation({
    mutationFn: () => api(`/api/repos/${props.repo.id}?force=true`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const cleanup = useMutation({
    mutationFn: () => api(`/api/repos/${props.repo.id}?force=true&cleanupWorktrees=true`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  return (
    <section className="panel">
      <h2>Actions</h2>
      <div className="stack-form">
        <Button type="button" variant="secondary" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          <RefreshCcw size={14} /> Refresh provider cache
        </Button>
        <Button type="button" variant="secondary" onClick={() => remove.mutate()} disabled={remove.isPending}>
          <Trash2 size={14} /> Remove tracking (keep worktrees)
        </Button>
        <Button type="button" onClick={() => cleanup.mutate()} disabled={cleanup.isPending}>
          <Trash2 size={14} /> Remove + clean worktrees
        </Button>
        <small>Status: {formatLabel(props.repo.archivedAt ? "archived" : "active")}</small>
      </div>
    </section>
  );
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="key-value">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function split(value: string) {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
