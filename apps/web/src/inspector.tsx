import type { AgentSession, Repo, Workspace, WorkspaceCockpitSummary, WorkspaceDiff } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ExternalLink,
  GitPullRequest,
  Hash,
  Loader2,
  PanelRightClose,
  RefreshCw,
  Slack,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { DeployedAppsPanel } from "./deployed-apps.js";
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
  // Diff count is shared between StatsTab (branch card) and the tab pill —
  // queried at the Inspector level so the count is always available regardless
  // of which tab is active. React Query dedupes with DiffTab's identical key.
  const diff = useQuery<WorkspaceDiff>({
    queryKey: ["diff", props.workspace.id],
    queryFn: () => api<WorkspaceDiff>(`/api/workspaces/${props.workspace.id}/diff`),
  });
  const fileCount = diff.data?.files.length ?? null;
  return (
    <>
      <div className="column-header inspector-head">
        <div className="inspector-head-title">
          <span className="inspector-eyebrow">Workspace</span>
          <span className="inspector-head-name">{props.workspace.name}</span>
        </div>
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
      </div>
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

  const diffFiles = props.diff?.files.length ?? 0;
  const diffAdded = additions || sumDiffLines(props.diff, "+");
  const diffRemoved = deletions || sumDiffLines(props.diff, "-");
  const issueKey = props.workspace.issueKey ?? props.summary?.issueTracker?.key ?? null;
  const issueTitle = props.workspace.issueTitle ?? props.summary?.issueTracker?.summary ?? null;
  const issueStatus = props.summary?.issueTracker?.issueStatus ?? null;
  const [checksOpen, setChecksOpen] = useState(false);
  const checksSummary = summarizeChecks(checks);

  return (
    <>
      {issueKey ? (
        <div className="inspector-attach">
          <a
            className="cit-jira"
            href={issueUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title={`Open ${issueKey}${issueTitle ? `: ${issueTitle}` : ""}`}
          >
            <span className="cit-jira-icon" aria-hidden>
              <svg viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="Issue tracker">
                <title>Issue tracker</title>
                <rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="oklch(50% 0.16 250)" />
                <path
                  d="M5 8.2l2 2 4-4"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="cit-jira-text">
              <span className="cit-jira-key">{issueKey}</span>
              {issueTitle ? <span className="cit-jira-title">{issueTitle}</span> : null}
            </span>
            {issueStatus ? (
              <span className={`cit-jira-status cit-jira-status--${jiraStatusTone(issueStatus)}`}>{issueStatus}</span>
            ) : null}
          </a>
        </div>
      ) : null}

      <div className="inspector-body">
        <BranchCard
          branch={props.workspace.branch}
          baseBranch={props.workspace.baseBranch}
          files={diffFiles}
          added={diffAdded}
          removed={diffRemoved}
          dirty={props.workspace.dirty}
        />

        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-section-label">Pull request</span>
          </div>
          <div className="ins-section-body">
            {pr ? (
              <div className="ins-pr">
                <div className="ins-pr-head">
                  <span className={`ins-pr-badge tone-${prTone}`}>
                    <GitPullRequest size={10} />
                    {formatLabel(pr.state)}
                  </span>
                  <a
                    className="ins-pr-num"
                    href={pr.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`Open PR #${pr.number}`}
                  >
                    #{pr.number} <ExternalLink size={9} />
                  </a>
                  <span className="ins-pr-base">
                    <span className="ins-mono">{props.workspace.branch}</span>
                    <span className="ins-pr-arrow">→</span>
                    <span className="ins-mono">{props.workspace.baseBranch}</span>
                  </span>
                </div>
                <div className="ins-pr-title">{pr.title}</div>
                <div className="ins-pr-stats">
                  <div className="ins-stat">
                    <div className="ins-stat-num">{diffFiles}</div>
                    <div className="ins-stat-label">files</div>
                  </div>
                  <div className="ins-stat">
                    <div className="ins-stat-num ins-stat-add">+{diffAdded}</div>
                    <div className="ins-stat-label">added</div>
                  </div>
                  <div className="ins-stat">
                    <div className="ins-stat-num ins-stat-del">−{diffRemoved}</div>
                    <div className="ins-stat-label">removed</div>
                  </div>
                  <div className="ins-pr-diffbar" aria-hidden>
                    <span className="ins-bar-add" style={{ flex: Math.max(diffAdded, 1) }} />
                    <span className="ins-bar-del" style={{ flex: Math.max(diffRemoved, 1) }} />
                    <span className="ins-bar-rest" style={{ flex: Math.max(diffFiles, 1) }} />
                  </div>
                </div>
                <div className="ins-pr-meta">
                  <span className="ins-pr-meta-text">
                    <span
                      className={`ch-pill ch-pill-${approvalTone === "approved" ? "ok" : approvalTone === "changes" ? "bad" : "mute"}`}
                    >
                      {approvalTone === "approved" ? "✓" : approvalTone === "changes" ? "!" : "·"}
                    </span>
                    {formatLabel(approvalTone)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="ins-empty">
                <div className="ins-empty-icon">
                  <GitPullRequest size={12} />
                </div>
                <div className="ins-empty-text">No PR for this branch yet.</div>
                <div className="ins-empty-hint">Push and open one when you're ready for review.</div>
              </div>
            )}
          </div>
        </section>

        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-section-label">Checks</span>
            {pr && checks.length ? (
              <button
                type="button"
                className="ch-toggle"
                onClick={() => setChecksOpen((v) => !v)}
                aria-expanded={checksOpen}
                title={checksOpen ? "Collapse checks" : "Expand checks"}
              >
                <ChevronDown
                  size={11}
                  style={{
                    transform: checksOpen ? "rotate(180deg)" : "rotate(0deg)",
                    transition: "transform 0.15s",
                  }}
                />
              </button>
            ) : null}
          </div>
          <div className="ins-section-body">
            {pr && checks.length ? (
              <>
                <div className={`ch-summary-row ch-summary-row--${checksSummary.tone}`}>
                  <CheckSummaryIcon tone={checksSummary.tone} />
                  <div>
                    <div className="ch-summary-title">{checksSummary.title}</div>
                    {checksSummary.sub ? <div className="ch-summary-sub">{checksSummary.sub}</div> : null}
                  </div>
                  <span className="ch-summary-rerun">
                    {checksSummary.bad > 0 ? (
                      <button
                        type="button"
                        className="ch-rerun"
                        title="Re-run failing checks"
                        aria-label="Re-run failing checks"
                      >
                        <RefreshCw size={11} />
                      </button>
                    ) : null}
                  </span>
                </div>
                {checksOpen ? (
                  <div className="check-list">
                    {checks.map((check) => (
                      <CheckRow key={`${check.name}-${check.conclusion ?? check.status}`} check={check} />
                    ))}
                  </div>
                ) : null}
              </>
            ) : pr ? (
              <div className="ins-empty">
                <div className="ins-empty-text">No checks reported.</div>
              </div>
            ) : (
              <div className="ins-empty">
                <div className="ins-empty-text">No PR — nothing to check.</div>
              </div>
            )}
          </div>
        </section>

        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-section-label">Attached</span>
          </div>
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
                <input
                  value={issueDraft}
                  onChange={(event) => setIssueDraft(event.target.value)}
                  placeholder="ABC-123"
                />
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
            {apps.actions.length ? (
              <div className="attach-row">
                {apps.actions.map((action) => (
                  <span key={action.id} className="attach-button" title={action.description ?? action.label}>
                    {action.label}
                  </span>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        <DeployedAppsPanel workspaceId={props.workspace.id} repo={props.repo} />
      </div>
    </>
  );
}

function BranchCard(props: {
  branch: string;
  baseBranch: string;
  files: number;
  added: number;
  removed: number;
  dirty: boolean;
}) {
  return (
    <section className="ins-card ins-card--branch">
      <div className="ins-branch-head">
        <span className="ins-branch-name">{props.branch}</span>
        <span className="ins-branch-base">→ {props.baseBranch}</span>
      </div>
      <div className="ins-branch-stats">
        <div className="ins-stat">
          <div className="ins-stat-num">{props.files}</div>
          <div className="ins-stat-label">files</div>
        </div>
        <div className="ins-stat">
          <div className="ins-stat-num ins-stat-add">+{props.added}</div>
          <div className="ins-stat-label">added</div>
        </div>
        <div className="ins-stat">
          <div className="ins-stat-num ins-stat-del">−{props.removed}</div>
          <div className="ins-stat-label">removed</div>
        </div>
      </div>
      <div className="ins-branch-bar" aria-hidden>
        <span className="ins-bar-add" style={{ flex: Math.max(props.added, 1) }} />
        <span className="ins-bar-del" style={{ flex: Math.max(props.removed, 1) }} />
        <span className="ins-bar-rest" style={{ flex: Math.max(props.files, 1) }} />
      </div>
      {props.dirty ? (
        <div className="ins-branch-meta">working tree dirty</div>
      ) : (
        <div className="ins-branch-meta">working tree clean</div>
      )}
    </section>
  );
}

function CheckSummaryIcon({ tone }: { tone: "ok" | "bad" | "run" | "mixed" }) {
  if (tone === "ok") {
    return (
      <span className="ch-status ch-status-ok" aria-hidden>
        <Check size={14} />
      </span>
    );
  }
  if (tone === "bad") {
    return (
      <span className="ch-status ch-status-bad" aria-hidden>
        <X size={14} />
      </span>
    );
  }
  if (tone === "run") {
    return (
      <span className="ch-status ch-status-run" aria-hidden>
        <Loader2 size={14} className="spin" />
      </span>
    );
  }
  return (
    <span className="ch-status ch-status-skip" aria-hidden>
      <Hash size={14} />
    </span>
  );
}

function summarizeChecks(checks: Array<{ status: string; conclusion: string | null }>) {
  let ok = 0;
  let bad = 0;
  let run = 0;
  let pend = 0;
  for (const check of checks) {
    const conclusion = (check.conclusion ?? "").toLowerCase();
    const status = check.status.toLowerCase();
    if (["failure", "cancelled", "timed_out", "action_required"].includes(conclusion)) bad += 1;
    else if (conclusion === "success") ok += 1;
    else if (
      status === "in_progress" ||
      status === "queued" ||
      status === "pending" ||
      (!conclusion && status !== "completed")
    )
      run += 1;
    else pend += 1;
  }
  const total = checks.length;
  let tone: "ok" | "bad" | "run" | "mixed" = "mixed";
  let title = `${total} checks`;
  let sub = "";
  if (bad === 0 && run === 0 && pend === 0) {
    tone = "ok";
    title = `All ${total} checks passed`;
  } else if (bad > 0 && run === 0) {
    tone = "bad";
    title = `${bad} ${bad === 1 ? "check" : "checks"} failing`;
    sub = `${ok}/${total} passed`;
  } else if (run > 0) {
    tone = "run";
    title = `${run} ${run === 1 ? "check" : "checks"} running`;
    sub = `${ok}/${total} passed`;
  } else {
    sub = `${ok} passed`;
  }
  return { ok, bad, run, pend, total, tone, title, sub };
}

function jiraStatusTone(status: string): "todo" | "progress" | "review" | "done" | "blocked" {
  const s = status.toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "done";
  if (s.includes("review")) return "review";
  if (s.includes("progress") || s.includes("doing")) return "progress";
  if (s.includes("block")) return "blocked";
  return "todo";
}

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
  // Subscribe to the same diff query the Inspector started so React-Query
  // returns the cached entry instantly when this tab mounts. initialData is
  // only set when we already have a value — passing undefined trips
  // exactOptionalPropertyTypes.
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

function checkTone(check: { conclusion: string | null; status: string }) {
  const conclusion = String(check.conclusion ?? "").toLowerCase();
  if (["failure", "cancelled", "timed_out", "action_required"].includes(conclusion)) return "failure";
  if (conclusion === "success") return "success";
  return "pending";
}

function CheckRow(props: {
  check: {
    name: string;
    status: string;
    conclusion: string | null;
    url: string | null;
    startedAt: string | null;
    completedAt: string | null;
  };
}) {
  const { check } = props;
  const tone = checkTone(check);
  const isRunning = isCheckRunning(check);
  const now = useNow(isRunning ? 1000 : null);
  const duration = formatCheckDuration(check, isRunning, now);
  const label = formatLabel(check.conclusion ?? check.status);
  const iconTone = isRunning ? "pending" : tone === "failure" ? "failure" : "success";
  return (
    <a
      className={`check-row ${tone}`}
      href={check.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      aria-label={`${check.name} — ${label}${duration ? ` — ${duration}` : ""}`}
      title={`${check.name} — ${label}`}
    >
      <span className={`check-icon tone-${iconTone}`} aria-hidden>
        {isRunning ? (
          <Loader2 size={14} className="spin" />
        ) : tone === "failure" ? (
          <X size={14} />
        ) : (
          <Check size={14} />
        )}
      </span>
      <span className="check-name" title={check.name}>
        {check.name}
      </span>
      <span className="check-duration command-result-meta">{duration || "—"}</span>
    </a>
  );
}

function isCheckRunning(check: { status: string; conclusion: string | null }) {
  if (check.conclusion) return false;
  const status = check.status.toLowerCase();
  return status !== "completed" && status !== "success" && status !== "failure";
}

function useNow(intervalMs: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (intervalMs == null) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function formatCheckDuration(
  check: { startedAt: string | null; completedAt: string | null },
  isRunning: boolean,
  nowMs: number,
) {
  const started = parseTime(check.startedAt);
  if (started == null) return "";
  const finished = isRunning ? nowMs : (parseTime(check.completedAt) ?? nowMs);
  const ms = Math.max(0, finished - started);
  return formatDurationMs(ms);
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function formatDurationMs(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return remMin ? `${hours}h ${remMin}m` : `${hours}h`;
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
