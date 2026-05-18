import type {
  AgentRuntime,
  CiProviderSummary,
  HookAction,
  HookDiagnostic,
  IssueTrackerSummary,
  IssueTransitionActionResult,
  ProviderHealth,
  Repo,
  VersionControlSummary,
  Workspace,
  WorkspaceAppsSummary,
  WorkspaceCockpitSummary,
} from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Play, RefreshCcw, Rocket, ShieldCheck } from "lucide-react";
import type React from "react";
import { useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

export function ProviderSummary(props: { repo: Repo; workspace: Workspace | null; providerHealth: ProviderHealth[] }) {
  const githubHealth = props.providerHealth.find((provider) => provider.id === "github-gh");
  const jiraHealth = props.providerHealth.find((provider) => provider.id === "jira-jtk");
  const githubAvailable = githubHealth?.status === "healthy";
  const jiraAvailable = jiraHealth?.status === "healthy";
  const summary = useQuery({
    queryKey: ["provider-summary", props.repo.id],
    enabled: githubAvailable,
    queryFn: () => api<{ versionControl: VersionControlSummary }>(`/api/repos/${props.repo.id}/provider-summary`),
  });
  const issueSummary = useQuery({
    queryKey: ["issue-summary", props.workspace?.id],
    enabled: Boolean(props.workspace?.issueKey) && jiraAvailable,
    queryFn: () => api<{ issueTracker: IssueTrackerSummary }>(`/api/workspaces/${props.workspace?.id}/issue-summary`),
  });
  const ciSummary = useQuery({
    queryKey: ["ci-runs", props.repo.id],
    enabled: githubAvailable,
    queryFn: () => api<{ ci: CiProviderSummary }>(`/api/repos/${props.repo.id}/ci-runs`),
  });
  const transition = useMutation({
    mutationFn: (transitionId: string) =>
      api<{ result: IssueTransitionActionResult }>(`/api/workspaces/${props.workspace?.id}/issue-transition`, {
        method: "POST",
        body: JSON.stringify({ transition: transitionId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issue-summary", props.workspace?.id] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const vc = summary.data?.versionControl;
  const issue = issueSummary.data?.issueTracker;
  const ci = ciSummary.data?.ci;
  return (
    <div className="provider-stack">
      {!githubAvailable && githubHealth ? (
        <HealthRow provider={{ ...githubHealth, displayName: "GitHub unavailable" }} />
      ) : null}
      {vc ? (
        <HealthTile
          title={vc.currentBranch || props.repo.defaultBranch}
          status={vc.status}
          detail={vc.pullRequest ? `PR #${vc.pullRequest.number}` : "No active PR"}
          note={vc.pullRequest?.title ?? vc.reason}
        />
      ) : null}
      {props.workspace?.issueKey && !jiraAvailable && jiraHealth ? (
        <HealthRow provider={{ ...jiraHealth, displayName: `${props.workspace.issueKey} unavailable` }} />
      ) : null}
      {issue ? (
        <HealthTile
          title={issue.key}
          status={issue.status}
          detail={issue.issueStatus || formatLabel(issue.status)}
          note={issue.summary ?? issue.reason}
        >
          {issue.transitions.length ? (
            <div className="inline-actions">
              {issue.transitions.slice(0, 4).map((candidate) => (
                <Button
                  key={candidate.id}
                  type="button"
                  variant="secondary"
                  disabled={transition.isPending || issue.status !== "healthy" || !jiraAvailable}
                  onClick={() => transition.mutate(candidate.id)}
                >
                  {candidate.toStatus}
                </Button>
              ))}
            </div>
          ) : null}
        </HealthTile>
      ) : null}
      {ci ? (
        <HealthTile
          title="Checks"
          status={ci.status}
          detail={ci.runs[0] ? `${ci.runs[0].name}: ${formatLabel(ci.runs[0].status)}` : formatLabel(ci.status)}
          note={ci.runs[0]?.conclusion ? formatLabel(ci.runs[0].conclusion) : ci.reason}
        />
      ) : null}
      {!vc && !issue && !ci ? (
        <div className="empty compact">Provider details are unavailable for this workspace</div>
      ) : null}
    </div>
  );
}

export function useWorkspaceCockpitSummary(workspace: Workspace | null) {
  return useQuery({
    queryKey: ["workspace-cockpit", workspace?.id],
    enabled: Boolean(workspace),
    refetchInterval: 10_000,
    queryFn: () => api<WorkspaceCockpitSummary>(`/api/workspaces/${workspace?.id}/cockpit-summary`),
  });
}

export function WorkspaceCockpitPanel(props: {
  summary: WorkspaceCockpitSummary | undefined;
  loading: boolean | undefined;
}) {
  const refresh = useMutation({
    mutationFn: () => api(`/api/workspaces/${props.summary?.workspaceId}/refresh`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", props.summary?.workspaceId] });
    },
  });
  if (props.loading) return <Empty text="Loading cockpit context" />;
  const summary = props.summary;
  if (!summary) return <Empty text="Cockpit context is unavailable" />;
  const pr = summary.versionControl.pullRequest;
  const checks = pr?.checks ?? [];
  return (
    <div className="cockpit-detail-stack">
      <div className="refresh-bar">
        <small>
          Updated: {new Date(summary.readiness.freshness.checkedAt).toLocaleTimeString()}{" "}
          {summary.readiness.freshness.degraded ? "· degraded" : ""}
        </small>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Refresh providers"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          <RefreshCcw size={14} />
        </Button>
      </div>
      <section className="detail-panel">
        <div className="detail-title">
          <ShieldCheck size={16} />
          <h2>Review</h2>
        </div>
        {pr ? (
          <>
            <div className="pr-summary-line">
              <a href={pr.url} target="_blank" rel="noreferrer">
                PR #{pr.number}: {pr.title}
              </a>
              <span>{formatLabel(pr.state)}</span>
              {pr.draft ? <span>Draft</span> : null}
              {pr.reviewDecision ? <span>{formatLabel(pr.reviewDecision)}</span> : null}
              <span className="diff-add">+{pr.additions ?? 0}</span>
              <span className="diff-del">-{pr.deletions ?? 0}</span>
            </div>
            <div className="check-list">
              {checks.length ? (
                checks.map((check) => (
                  <a
                    key={`${check.name}-${check.status}-${check.conclusion ?? ""}`}
                    className={`check-row ${check.conclusion || check.status}`}
                    href={check.url ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <strong>{check.name}</strong>
                    <span>{formatLabel(check.conclusion ?? check.status)}</span>
                  </a>
                ))
              ) : (
                <div className="empty compact">No check data reported by the PR provider</div>
              )}
            </div>
          </>
        ) : (
          <div className="empty compact">No active PR for this workspace branch</div>
        )}
      </section>
      <GitStatusCard summary={summary} />
      <AppsActionsPanel apps={summary.apps} />
    </div>
  );
}

export function AppsActionsPanel(props: { apps: WorkspaceAppsSummary | undefined }) {
  const apps = props.apps;
  const runAction = useMutation({
    mutationFn: (action: HookAction) =>
      api(`/api/workspaces/${apps?.workspaceId}/actions`, {
        method: "POST",
        body: JSON.stringify(action),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", apps?.workspaceId] });
    },
  });
  if (!apps) return <Empty text="Workspace apps unavailable" />;
  return (
    <section className="detail-panel apps-panel">
      <div className="detail-title">
        <Rocket size={16} />
        <h2>Apps and actions</h2>
        <span>{formatLabel(apps.status)}</span>
      </div>
      {apps.applications.length ? (
        <div className="app-list">
          {apps.applications.map((app) => (
            <a
              key={app.id}
              className={`app-row ${app.status}`}
              href={app.url ?? undefined}
              target="_blank"
              rel="noreferrer"
            >
              <strong>{app.label}</strong>
              <span>{app.environment ?? formatLabel(app.kind)}</span>
              <em>{formatLabel(app.status)}</em>
            </a>
          ))}
        </div>
      ) : (
        <div className="empty compact">No deployed applications discovered for this workspace</div>
      )}
      {apps.links.length ? (
        <div className="link-cloud">
          {apps.links.map((link) => (
            <a key={`${link.kind}-${link.url}`} href={link.url} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />
              {link.label}
              <span>{formatLabel(link.kind)}</span>
            </a>
          ))}
        </div>
      ) : null}
      {apps.actions.length ? (
        <div className="action-list">
          {apps.actions.map((action) => (
            <div key={action.id} className="action-row">
              <div>
                <strong>{action.label}</strong>
                <span>{action.description || formatLabel(action.kind ?? "custom")}</span>
              </div>
              {action.executable ? (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={runAction.isPending}
                  onClick={() => runAction.mutate(action)}
                >
                  <Play size={14} /> Run
                </Button>
              ) : action.url ? (
                <a href={action.url} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {apps.reason ? <p className="panel-note">{apps.reason}</p> : null}
    </section>
  );
}

export function HookDiagnosticsPanel(props: { repo: Repo | null; workspace: Workspace | null }) {
  const diagnostics = useQuery({
    queryKey: ["hook-diagnostics", props.repo?.id],
    enabled: Boolean(props.repo),
    queryFn: () =>
      api<{ diagnostics: HookDiagnostic[]; sample: unknown }>(`/api/repos/${props.repo?.id}/hook-diagnostics`),
  });
  return (
    <div className="hook-diagnostics">
      {diagnostics.data?.diagnostics.length ? (
        diagnostics.data.diagnostics.map((hook) => (
          <HookDiagnosticRow key={`${hook.event}-${hook.hookId}`} hook={hook} />
        ))
      ) : (
        <div className="empty compact">No repo hooks configured for this repo</div>
      )}
      {diagnostics.data?.sample ? (
        <details className="schema-sample">
          <summary>Expected app/action payload</summary>
          <pre>{JSON.stringify(diagnostics.data.sample, null, 2)}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function HealthRow(props: { provider: ProviderHealth }) {
  return (
    <div className={`health ${props.provider.status}`}>
      <strong>{props.provider.displayName}</strong>
      <span>{formatLabel(props.provider.status)}</span>
      {props.provider.reason ? <p>{props.provider.reason}</p> : null}
    </div>
  );
}

type RepoInspectResult = {
  rootPath: string;
  exists: boolean;
  isGit: boolean;
  defaultBranch: string | null;
  remotes: string[];
  suggestedWorktreeParent: string;
  providerCandidates: Array<{ id: string; displayName: string; enabled: boolean }>;
};

export function RepoForm() {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [worktreeParent, setWorktreeParent] = useState("");
  const inspect = useMutation({
    mutationFn: () =>
      api<RepoInspectResult>("/api/repos/inspect", {
        method: "POST",
        body: JSON.stringify({ rootPath }),
      }),
    onSuccess: (result) => {
      if (result.isGit && !worktreeParent) setWorktreeParent(result.suggestedWorktreeParent);
    },
  });
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          rootPath,
          name: name || undefined,
          worktreeParent: worktreeParent || undefined,
        }),
      }),
    onSuccess: () => {
      setRootPath("");
      setName("");
      setWorktreeParent("");
      inspect.reset();
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const inspected = inspect.data;
  const canRegister = inspected?.isGit ?? false;
  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!inspected || inspected.rootPath !== rootPath) {
          inspect.mutate();
          return;
        }
        if (!canRegister) return;
        mutation.mutate();
      }}
    >
      <label>
        Repo path
        <input
          value={rootPath}
          onChange={(event) => {
            setRootPath(event.target.value);
            inspect.reset();
          }}
          placeholder="/home/me/project"
        />
      </label>
      {inspected ? (
        <div className={`repo-inspect ${inspected.isGit ? "ok" : "warn"}`}>
          {inspected.isGit ? (
            <>
              <small>
                default branch: <code>{inspected.defaultBranch ?? "?"}</code>
              </small>
              <small>remotes: {inspected.remotes.join(", ") || "(none)"}</small>
              <small>
                providers:{" "}
                {inspected.providerCandidates
                  .filter((candidate) => candidate.enabled)
                  .map((candidate) => candidate.displayName)
                  .join(", ") || "(none)"}
              </small>
            </>
          ) : (
            <small>{inspected.exists ? "Not a git repository (.git missing)" : "Path does not exist"}</small>
          )}
        </div>
      ) : null}
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional display name" />
      </label>
      <label>
        Worktree parent
        <input
          value={worktreeParent}
          onChange={(event) => setWorktreeParent(event.target.value)}
          placeholder={inspected?.suggestedWorktreeParent ?? "/path/to/worktree-parent"}
        />
      </label>
      <Button type="submit" disabled={!rootPath || mutation.isPending || inspect.isPending}>
        {!inspected || inspected.rootPath !== rootPath
          ? "Inspect path"
          : canRegister
            ? "Register repo"
            : "Path invalid"}
      </Button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
      {inspect.error ? <p>{String(inspect.error)}</p> : null}
    </form>
  );
}

type WorkspaceSource = "scratch" | "issue" | "imported" | "pr";

export function WorkspaceForm(props: { repo: Repo }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<WorkspaceSource>("scratch");
  const [issueKey, setIssueKey] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [prUrl, setPrUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const branches = useQuery({
    queryKey: ["repo-branches", props.repo.id],
    queryFn: () =>
      api<{ defaultBranch: string; local: string[]; remote: string[]; error?: string }>(
        `/api/repos/${props.repo.id}/branches`,
      ),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          repoId: props.repo.id,
          name: name || (source === "imported" ? existingBranch : name),
          source,
          issueKey: issueKey || undefined,
          issueTitle: issueTitle || undefined,
          prUrl: prUrl || undefined,
          baseBranch: baseBranch || undefined,
          existingBranch: source === "imported" && existingBranch ? existingBranch : undefined,
        }),
      }),
    onSuccess: () => {
      setName("");
      setIssueKey("");
      setIssueTitle("");
      setPrUrl("");
      setExistingBranch("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const previewBranch = source === "imported" && existingBranch ? existingBranch : name || "(branch from name)";
  const previewBase = baseBranch || branches.data?.defaultBranch || props.repo.defaultBranch;
  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        Workspace
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="short-task-name" />
      </label>
      <label>
        Source
        <select value={source} onChange={(event) => setSource(event.target.value as WorkspaceSource)}>
          <option value="scratch">Scratch (new branch)</option>
          <option value="imported">From existing branch</option>
          <option value="issue">From Jira issue</option>
          <option value="pr">From pull request</option>
        </select>
      </label>
      {source !== "imported" ? (
        <label>
          Base branch
          <select value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)}>
            <option value="">{branches.data?.defaultBranch || props.repo.defaultBranch}</option>
            {(branches.data?.remote ?? []).map((branch) => (
              <option key={`rb-${branch}`} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "imported" ? (
        <label>
          Existing branch
          <select value={existingBranch} onChange={(event) => setExistingBranch(event.target.value)}>
            <option value="">Select a branch</option>
            {(branches.data?.local ?? []).map((branch) => (
              <option key={`lb-${branch}`} value={branch}>
                {branch} (local)
              </option>
            ))}
            {(branches.data?.remote ?? []).map((branch) => (
              <option key={`rb2-${branch}`} value={branch}>
                {branch} (remote)
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {source === "issue" ? (
        <>
          <label>
            Issue key
            <input value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="MS-123" />
          </label>
          <label>
            Issue title
            <input
              value={issueTitle}
              onChange={(event) => setIssueTitle(event.target.value)}
              placeholder="Optional title"
            />
          </label>
        </>
      ) : null}
      {source === "pr" ? (
        <label>
          PR URL
          <input
            value={prUrl}
            onChange={(event) => setPrUrl(event.target.value)}
            placeholder="https://github.com/org/repo/pull/123"
          />
        </label>
      ) : null}
      <div className="workspace-preview">
        <small>
          branch: <code>{previewBranch}</code>
        </small>
        <small>
          base: <code>{previewBase}</code>
        </small>
      </div>
      <Button
        type="submit"
        disabled={
          mutation.isPending ||
          (source === "imported" ? !existingBranch : !name) ||
          (source === "issue" && !issueKey) ||
          (source === "pr" && !prUrl)
        }
      >
        Create workspace
      </Button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

export function RuntimeLauncher(props: { workspace: Workspace; runtimes: AgentRuntime[] }) {
  const [runtimeId, setRuntimeId] = useState(props.runtimes[0]?.id ?? "shell");
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: props.workspace.id, runtimeId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const runtime = useMemo(
    () => props.runtimes.find((candidate) => candidate.id === runtimeId),
    [props.runtimes, runtimeId],
  );
  return (
    <div className="runtime-launcher">
      <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
        {props.runtimes.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.displayName} - {candidate.health}
          </option>
        ))}
      </select>
      <Button
        type="button"
        disabled={!runtime || runtime.health !== "healthy" || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <Play size={15} /> Start session
      </Button>
      {runtime?.healthReason ? <p>{runtime.healthReason}</p> : null}
    </div>
  );
}

export { DiffPanel, TerminalPane } from "./terminal-pane.js";

function HealthTile(props: {
  title: string;
  status: string;
  detail: string;
  note?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className={`health ${props.status}`}>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.note ? <p>{props.note}</p> : null}
      {props.children}
    </div>
  );
}

function GitStatusCard(props: { summary: WorkspaceCockpitSummary }) {
  const git = props.summary.git;
  return (
    <section className={`detail-panel git-panel ${git.clean ? "clean" : "dirty"}`}>
      <div className="detail-title">
        <h2>Git status</h2>
        <span>{git.clean ? "Clean" : "Dirty"}</span>
        {git.ahead ? <span>ahead {git.ahead}</span> : null}
        {git.behind ? <span>behind {git.behind}</span> : null}
      </div>
      <div className="git-counts">
        <span>{git.modified} modified</span>
        <span>{git.staged} staged</span>
        <span>{git.untracked} untracked</span>
        <span>{git.deleted} deleted</span>
        <span>{git.renamed} renamed</span>
        <span>{git.conflicted} conflicted</span>
      </div>
      {git.lines.length ? <pre>{git.lines.join("\n")}</pre> : <div className="empty compact">Working tree clean</div>}
    </section>
  );
}

function HookDiagnosticRow(props: { hook: HookDiagnostic }) {
  return (
    <details className={`hook-row ${props.hook.validationStatus}`}>
      <summary>
        <strong>{props.hook.hookId}</strong>
        <span>{props.hook.event}</span>
        <em>{props.hook.validationStatus}</em>
      </summary>
      <div className="hook-grid">
        <KeyValue label="Command" value={[props.hook.command, ...props.hook.args].join(" ")} />
        <KeyValue label="CWD" value={props.hook.cwd ?? "workspace"} />
        <KeyValue label="Blocking" value={props.hook.blocking ? "yes" : "no"} />
        <KeyValue label="Last run" value={props.hook.lastRunAt ?? "not run"} />
      </div>
      {props.hook.validationErrors.length ? <pre>{props.hook.validationErrors.join("\n")}</pre> : null}
      {props.hook.structuredPayload ? <pre>{JSON.stringify(props.hook.structuredPayload, null, 2)}</pre> : null}
    </details>
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

function Empty(props: { text: string }) {
  return <div className="empty">{props.text}</div>;
}
