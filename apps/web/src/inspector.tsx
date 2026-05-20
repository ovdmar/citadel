import type { AgentSession, Repo, Workspace, WorkspaceCockpitSummary, WorkspaceDiff } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { GitPullRequest, Hash, PanelRightClose, Settings, Slack } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";
import { type ApprovalTone, approvalToneFor, prToneFor } from "./workspace-card.js";

type InspectorTab = "stats" | "diff";

export function Inspector(props: {
  workspace: Workspace;
  repo: Repo | null;
  sessions: AgentSession[];
  summary: WorkspaceCockpitSummary | undefined;
  onCollapse: () => void;
}) {
  const [tab, setTab] = useState<InspectorTab>("stats");
  return (
    <>
      <div className="column-header">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={props.onCollapse}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <PanelRightClose size={14} />
        </Button>
        <strong>Workspace</strong>
        <span className="header-spacer" />
      </div>
      <div className="inspector-tabs">
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
        </button>
      </div>
      <div className="column-body">
        {tab === "stats" ? (
          <StatsTab workspace={props.workspace} repo={props.repo} summary={props.summary} />
        ) : (
          <DiffTab workspace={props.workspace} summary={props.summary} />
        )}
      </div>
    </>
  );
}

function StatsTab(props: {
  workspace: Workspace;
  repo: Repo | null;
  summary: WorkspaceCockpitSummary | undefined;
}) {
  const pr = props.summary?.versionControl.pullRequest ?? null;
  const prTone = prToneFor(pr);
  const approvalTone: ApprovalTone = approvalToneFor(pr);
  const additions = pr?.additions ?? 0;
  const deletions = pr?.deletions ?? 0;
  const apps = props.summary?.apps;
  const checks = pr?.checks ?? [];

  const issueUrl = props.workspace.issueUrl ?? props.summary?.issueTracker?.url ?? null;
  const slackThreadUrl = props.workspace.slackThreadUrl;

  const attachIssue = useMutation({
    mutationFn: (input: { issueKey: string; issueTitle?: string; issueUrl?: string }) =>
      api(`/api/workspaces/${props.workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          issueKey: input.issueKey,
          issueTitle: input.issueTitle ?? null,
          issueUrl: input.issueUrl || null,
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const attachSlack = useMutation({
    mutationFn: (slackThreadUrl: string) =>
      api(`/api/workspaces/${props.workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ slackThreadUrl }),
      }),
    onSuccess: () => {
      setShowSlackAttach(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const [issueDraft, setIssueDraft] = useState("");
  const [issueUrlDraft, setIssueUrlDraft] = useState("");
  const [showIssueAttach, setShowIssueAttach] = useState(false);
  const [slackDraft, setSlackDraft] = useState("");
  const [showSlackAttach, setShowSlackAttach] = useState(false);

  return (
    <div className="inspector-body">
      <section className="inspector-block">
        <h4>PR</h4>
        {pr ? (
          <div className="pr-summary">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className={`attach-button attached tone-${approvalTone === "approved" ? "success" : approvalTone === "changes" ? "danger" : "warning"}`}
              title={`PR #${pr.number}: ${pr.title}`}
            >
              <GitPullRequest size={12} /> #{pr.number}
            </a>
            <div className="command-result-meta">
              <span className="diff-add">+{additions}</span>
              <span className="diff-del"> −{deletions}</span>
              {" · "}
              <span
                className={`tone-${prTone === "passing" ? "success" : prTone === "failing" ? "failure" : "pending"}`}
              >
                {formatLabel(prTone)}
              </span>
              {" · "}
              <strong>{approvalTone}</strong>
            </div>
          </div>
        ) : (
          <div className="empty compact">
            <GitPullRequest size={12} /> No PR for this branch yet.
          </div>
        )}
      </section>

      <section className="inspector-block">
        <h4>PR checks</h4>
        {pr ? (
          <div className="check-list">
            {checks.length ? (
              checks.map((check) => (
                <a
                  key={`${check.name}-${check.conclusion ?? check.status}`}
                  className="check-row"
                  href={check.url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                >
                  <strong>{check.name}</strong>
                  <span className={`tone-${checkTone(check)}`}>{formatLabel(check.conclusion ?? check.status)}</span>
                </a>
              ))
            ) : (
              <div className="empty compact">PR exists but no checks reported yet.</div>
            )}
          </div>
        ) : (
          <div className="empty compact">No PR yet, nothing to check.</div>
        )}
      </section>

      <section className="inspector-block">
        <h4>Attached</h4>
        <div className="attach-row">
          {slackThreadUrl ? (
            <a
              className="attach-button attached"
              href={slackThreadUrl}
              target="_blank"
              rel="noreferrer"
              title="Open linked Slack thread"
            >
              <Slack size={12} /> Slack
            </a>
          ) : (
            <button
              type="button"
              className={`attach-button ${showSlackAttach ? "tone-warning" : ""}`}
              onClick={() => setShowSlackAttach((v) => !v)}
              title="Attach Slack conversation"
            >
              <Slack size={12} /> {showSlackAttach ? "Cancel" : "Slack"}
            </button>
          )}
          {issueUrl ? (
            <a
              className="attach-button attached"
              href={issueUrl}
              target="_blank"
              rel="noreferrer"
              title={props.workspace.issueKey ? `Open ${props.workspace.issueKey}` : "Open linked issue"}
            >
              <Hash size={12} /> {props.workspace.issueKey ?? "Issue"}
            </a>
          ) : (
            <button
              type="button"
              className={`attach-button ${props.workspace.issueKey ? "attached" : ""}`}
              onClick={() => setShowIssueAttach((v) => !v)}
              title={props.workspace.issueKey ? `Attached ${props.workspace.issueKey}; add URL` : "Attach issue"}
            >
              <Hash size={12} /> {props.workspace.issueKey ?? "Issue"}
            </button>
          )}
        </div>
        {showSlackAttach ? (
          <div className="modal-form">
            <label>
              Slack thread URL
              <input
                value={slackDraft}
                onChange={(event) => setSlackDraft(event.target.value)}
                placeholder="https://slack.com/archives/CHANNEL/p123..."
              />
            </label>
            <Button
              type="button"
              variant="secondary"
              onClick={() => attachSlack.mutate(slackDraft.trim())}
              disabled={!slackDraft.trim() || attachSlack.isPending}
            >
              {attachSlack.isPending ? "Attaching…" : "Attach Slack"}
            </Button>
          </div>
        ) : null}
        {showIssueAttach ? (
          <div className="modal-form">
            <label>
              Issue key
              <input value={issueDraft} onChange={(event) => setIssueDraft(event.target.value)} placeholder="ABC-123" />
            </label>
            <label>
              Issue URL
              <input
                value={issueUrlDraft}
                onChange={(event) => setIssueUrlDraft(event.target.value)}
                placeholder="https://jira.example/browse/ABC-123"
              />
            </label>
            <Button
              type="button"
              disabled={!issueDraft.trim() || attachIssue.isPending}
              onClick={() => attachIssue.mutate({ issueKey: issueDraft.trim(), issueUrl: issueUrlDraft.trim() })}
            >
              {attachIssue.isPending ? "Attaching…" : "Attach issue"}
            </Button>
          </div>
        ) : null}
      </section>

      <section className="inspector-block">
        <h4>Deployed apps</h4>
        {apps?.applications.length ? (
          <div className="app-chip-grid">
            {apps.applications.map((app) => (
              <a
                key={app.id}
                className={`app-chip tone-${app.status}`}
                href={app.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                title={`${app.label}${app.environment ? ` · ${app.environment}` : ""} · ${app.status}`}
              >
                <span className="dot" />
                <span>{app.label}</span>
                <span className="command-result-meta">{app.environment ?? formatLabel(app.kind)}</span>
              </a>
            ))}
          </div>
        ) : (
          <DeployedAppsEmpty repo={props.repo} reason={apps?.reason ?? null} />
        )}
        {apps?.actions.length ? (
          <div className="attach-row">
            {apps.actions.map((action) => (
              <span key={action.id} className="attach-button" title={action.description ?? action.label}>
                {action.label}
              </span>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function DiffTab(props: { workspace: Workspace; summary: WorkspaceCockpitSummary | undefined }) {
  const diff = useQuery<WorkspaceDiff>({
    queryKey: ["diff", props.workspace.id],
    queryFn: () => api<WorkspaceDiff>(`/api/workspaces/${props.workspace.id}/diff`),
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

function DeployedAppsEmpty(props: { repo: Repo | null; reason: string | null }) {
  return (
    <div className="empty-state-mock" aria-label="No deployed apps configured">
      <div className="empty-state-reason">
        <Settings size={12} />
        <span>{props.reason ?? "No app discovery hook configured for this repo."}</span>
      </div>
      <div className="empty-state-preview" aria-hidden>
        <div className="app-chip tone-healthy">
          <span className="dot" />
          <span>web</span>
          <span className="command-result-meta">production</span>
        </div>
        <div className="app-chip tone-degraded">
          <span className="dot" />
          <span>api</span>
          <span className="command-result-meta">staging</span>
        </div>
        <div className="app-chip tone-unavailable">
          <span className="dot" />
          <span>worker</span>
          <span className="command-result-meta">preview</span>
        </div>
      </div>
      <p className="empty-state-hint">
        Configure an `apps` hook for this repo to surface deploys, URLs, and quick actions.
      </p>
      {props.repo ? (
        <Link
          to="/repos/$repoId"
          params={{ repoId: props.repo.id }}
          className="settings-link"
          title="Configure deploy hooks for this repo"
        >
          Configure hooks
        </Link>
      ) : (
        <Link to="/settings" className="settings-link" title="Open settings">
          Open settings
        </Link>
      )}
    </div>
  );
}

function checkTone(check: { conclusion: string | null; status: string }) {
  const conclusion = String(check.conclusion ?? "").toLowerCase();
  if (["failure", "cancelled", "timed_out", "action_required"].includes(conclusion)) return "failure";
  if (conclusion === "success") return "success";
  return "pending";
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
