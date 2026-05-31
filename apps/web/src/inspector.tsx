import type {
  AgentSession,
  Repo,
  Workspace,
  WorkspaceCockpitSummary,
  WorkspaceDiff,
  WorkspaceRecentCommits,
} from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { PanelRightClose, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { DeployedAppsPanel } from "./deployed-apps.js";
import { InspectorPrSection } from "./inspector-pr.js";
import { aggregateReviewerCounts } from "./inspector-reviewers.js";
import { IssueAttachSlot } from "./jira-picker.js";

// Re-export so existing consumers (incl. inspector.test.ts) keep working.
export { aggregateReviewerCounts } from "./inspector-reviewers.js";

type InspectorTab = "stats" | "diff";

export function Inspector(props: {
  workspace: Workspace;
  repo: Repo | null;
  sessions: AgentSession[];
  summary: WorkspaceCockpitSummary | undefined;
  onCollapse: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>("stats");
  const diff = useQuery<WorkspaceDiff>({
    queryKey: ["diff", props.workspace.id],
    queryFn: () => api<WorkspaceDiff>(`/api/workspaces/${props.workspace.id}/diff`),
  });
  const fileCount = diff.data?.files.length ?? null;
  return (
    <>
      <div className="inspector-tabs" data-active={tab}>
        <button
          type="button"
          className={`inspector-tab ${tab === "stats" ? "active" : ""}`}
          onClick={() => setTab("stats")}
          title="PR and check stats"
        >
          Stats
        </button>
        <button
          type="button"
          className={`inspector-tab ${tab === "diff" ? "active" : ""}`}
          onClick={() => setTab("diff")}
          title="Changed files and working tree diff"
        >
          Diff
          {fileCount !== null && fileCount > 0 ? <span className="inspector-tab-count">{fileCount}</span> : null}
        </button>
        <span className="inspector-tab-indicator" data-tab={tab} aria-hidden />
        <button
          type="button"
          className="cit-icon-btn cit-icon-btn--sm inspector-tabs-collapse"
          onClick={props.onCollapse}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <PanelRightClose size={14} />
        </button>
      </div>
      <div className="column-body">
        {tab === "stats" ? (
          <StatsTab workspace={props.workspace} repo={props.repo} summary={props.summary} diff={diff.data} />
        ) : (
          <DiffTab workspace={props.workspace} summary={props.summary} diff={diff.data} />
        )}
      </div>
    </>
  );
}

function StatsTab(props: {
  workspace: Workspace;
  repo: Repo | null;
  summary: WorkspaceCockpitSummary | undefined;
  diff: WorkspaceDiff | undefined;
}) {
  const pr = props.summary?.versionControl.pullRequest ?? null;
  const additions = pr?.additions ?? 0;
  const deletions = pr?.deletions ?? 0;
  const apps = props.summary?.apps;

  const issueUrl = props.workspace.issueUrl ?? props.summary?.issueTracker?.url ?? null;
  const diffFiles = props.diff?.files.length ?? 0;
  const diffAdded = additions || sumDiffLines(props.diff, "+");
  const diffRemoved = deletions || sumDiffLines(props.diff, "-");
  const issueKey = props.workspace.issueKey ?? props.summary?.issueTracker?.key ?? null;
  const issueTitle = props.workspace.issueTitle ?? props.summary?.issueTracker?.summary ?? null;
  const issueStatus = props.summary?.issueTracker?.issueStatus ?? null;

  const recent = useQuery<WorkspaceRecentCommits>({
    queryKey: ["recent-commits", props.workspace.id, 20],
    queryFn: () => api<WorkspaceRecentCommits>(`/api/workspaces/${props.workspace.id}/recent-commits?limit=20`),
    staleTime: 30_000,
  });
  const [recentExpanded, setRecentExpanded] = useState(false);
  const recentCommits = recent.data?.commits ?? [];
  const visibleRecent = recentExpanded ? recentCommits : recentCommits.slice(0, 5);

  return (
    <>
      <IssueAttachSlot
        workspaceId={props.workspace.id}
        issueKey={issueKey}
        issueTitle={issueTitle}
        issueStatus={issueStatus}
        issueUrl={issueUrl}
        transitions={props.summary?.issueTracker?.transitions ?? []}
      />

      <div className="inspector-body">
        <InspectorPrSection
          workspace={props.workspace}
          pr={pr}
          diffFiles={diffFiles}
          diffAdded={diffAdded}
          diffRemoved={diffRemoved}
          checkedAt={props.summary?.versionControl.checkedAt}
        />

        {apps?.applications.length ? (
          <section className="ins-section">
            <div className="ins-section-head">
              <span className="ins-section-label">Local deploys</span>
            </div>
            <div className="app-chip-grid ins-deploy-chips">
              {apps.applications.map((app) => (
                <div
                  key={app.id}
                  className={`app-chip ins-chip tone-${app.status} ins-chip--${app.status === "healthy" ? "up" : app.status === "degraded" ? "restarting" : "down"}`}
                  title={`${app.label}${app.environment ? ` · ${app.environment}` : ""} · ${app.status}`}
                >
                  <a className="ins-chip-tap" href={app.url ?? undefined} target="_blank" rel="noreferrer">
                    <span
                      className={`cit-pulse cit-pulse-sm ${app.status === "healthy" ? "cit-pulse-ok" : app.status === "degraded" ? "cit-pulse-run" : "cit-pulse-bad"}`}
                    />
                    <span className="ins-chip-name">{app.label}</span>
                  </a>
                  <button type="button" className="ins-chip-reload" title="Redeploy" aria-label="Redeploy">
                    <RefreshCw size={11} />
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <DeployedAppsPanel workspaceId={props.workspace.id} repo={props.repo} />

        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-section-label">Recent</span>
          </div>
          <div className="ins-section-body">
            {recent.isLoading ? (
              <div className="ins-empty">
                <div className="ins-empty-text">Reading git log…</div>
              </div>
            ) : recentCommits.length ? (
              <>
                <ul className="ins-recent">
                  {visibleRecent.map((commit) => (
                    <li key={commit.sha} title={`${commit.author} · ${commit.isoTime}`}>
                      <span className="ins-recent-sha">{commit.shortSha}</span>
                      <span className="ins-recent-msg">{commit.message}</span>
                      <span className="ins-recent-time">{shortenRelative(commit.relativeTime)}</span>
                    </li>
                  ))}
                </ul>
                {recentCommits.length > 5 ? (
                  <button type="button" className="ins-recent-more" onClick={() => setRecentExpanded((v) => !v)}>
                    {recentExpanded ? "Show fewer" : `Show ${recentCommits.length - 5} more`}
                  </button>
                ) : null}
              </>
            ) : (
              <div className="ins-empty">
                <div className="ins-empty-text">No commits in this workspace yet.</div>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

export function shortenRelative(value: string) {
  if (!value) return "";
  // git's "ago" strings (e.g. "3 minutes ago") read better trimmed in the chip.
  return value
    .replace(/ ago$/, "")
    .replace(/(\d+) minutes?/, "$1m")
    .replace(/(\d+) hours?/, "$1h")
    .replace(/(\d+) days?/, "$1d")
    .replace(/(\d+) weeks?/, "$1w")
    .replace(/(\d+) months?/, "$1mo")
    .replace(/(\d+) years?/, "$1y")
    .replace(/(\d+) seconds?/, "$1s");
}

// CheckSummaryIcon + summarizeChecks moved to inspector-pr.js during the
// PR-section extraction on main. jiraStatusTone moved to jira-picker.tsx
// during the picker extraction on this branch. Neither belongs here
// anymore.

function sumDiffLines(diff: WorkspaceDiff | undefined, prefix: "+" | "-"): number {
  if (!diff) return 0;
  let total = 0;
  for (const file of diff.files) total += countLines(file.diff, prefix);
  return total;
}

function DiffTab(props: {
  workspace: Workspace;
  summary: WorkspaceCockpitSummary | undefined;
  diff: WorkspaceDiff | undefined;
}) {
  const diff = useQuery<WorkspaceDiff>({
    queryKey: ["diff", props.workspace.id],
    queryFn: () => api<WorkspaceDiff>(`/api/workspaces/${props.workspace.id}/diff`),
    ...(props.diff ? { initialData: props.diff } : {}),
  });
  const git = props.summary?.git;
  return (
    <div className="inspector-body">
      <section className="inspector-block">
        <h4>Working tree</h4>
        <div className="command-result-meta">
          {git ? (
            <>
              {git.clean ? "clean" : "dirty"} · ahead {git.ahead} · behind {git.behind}
            </>
          ) : (
            "Loading…"
          )}
        </div>
      </section>
      <section className="inspector-block">
        <h4>Changed files</h4>
        {diff.isLoading ? <div className="empty compact">Reading git diff…</div> : null}
        {diff.data?.clean ? <div className="empty compact">Workspace is clean.</div> : null}
        {diff.data?.files.length ? (
          <div className="check-list">
            {diff.data.files.map((file) => (
              <div key={file.path} className="diff-file">
                <span className="path" title={file.path}>
                  {file.path}
                </span>
                <span className="workspace-card-diff">
                  <span className="diff-add">+{countLines(file.diff, "+")}</span>
                  <span className="diff-del">-{countLines(file.diff, "-")}</span>
                </span>
              </div>
            ))}
          </div>
        ) : null}
        {diff.data?.truncated ? <small>Diff truncated.</small> : null}
      </section>
      <section className="inspector-block">
        <h4>Human review</h4>
        <div className="empty compact">
          Full-screen review with inline comments visible to the agent is planned. Open the PR for now.
        </div>
      </section>
    </div>
  );
}

function countLines(diff: string, prefix: "+" | "-") {
  if (!diff) return 0;
  let count = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix}`)) count += 1;
  }
  return count;
}

export type { InspectorTab };
