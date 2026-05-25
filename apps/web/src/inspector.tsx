import type {
  AgentSession,
  Repo,
  Workspace,
  WorkspaceCockpitSummary,
  WorkspaceDiff,
  WorkspaceRecentCommits,
} from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ExternalLink, GitPullRequest, Hash, Loader2, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { DeployedAppsPanel } from "./deployed-apps.js";
import { ReviewTab } from "./inspector-review.js";
import { ReviewerAvatars, aggregateReviewerCounts } from "./inspector-reviewers.js";
import { formatLabel } from "./labels.js";
import { prToneFor } from "./workspace-card.js";

// Re-export so existing consumers (incl. inspector.test.ts) keep working.
export { aggregateReviewerCounts } from "./inspector-reviewers.js";

type InspectorTab = "stats" | "diff" | "review";

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
        <button
          type="button"
          className={`inspector-tab ${tab === "review" ? "active" : ""}`}
          onClick={() => setTab("review")}
          title="Request review and read citadel-native comments"
        >
          Review
        </button>
        <span className="inspector-tab-indicator" data-tab={tab} aria-hidden />
        <button
          type="button"
          className="cit-icon-btn cit-icon-btn--sm inspector-tabs-collapse"
          onClick={props.onCollapse}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <X size={12} />
        </button>
      </div>
      <div className="column-body">
        {tab === "stats" ? (
          <StatsTab workspace={props.workspace} repo={props.repo} summary={props.summary} diff={diff.data} />
        ) : tab === "diff" ? (
          <DiffTab workspace={props.workspace} summary={props.summary} diff={diff.data} />
        ) : (
          <ReviewTab
            workspace={props.workspace}
            diff={diff.data}
            hasRequestReviewHook={
              (props.repo?.requestReviewHookIds?.length ?? 0) > 0
            }
          />
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
  const additions = pr?.additions ?? 0;
  const deletions = pr?.deletions ?? 0;
  const apps = props.summary?.apps;
  const checks = pr?.checks ?? [];

  const issueUrl = props.workspace.issueUrl ?? props.summary?.issueTracker?.url ?? null;
  const diffFiles = props.diff?.files.length ?? 0;
  const diffAdded = additions || sumDiffLines(props.diff, "+");
  const diffRemoved = deletions || sumDiffLines(props.diff, "-");
  const issueKey = props.workspace.issueKey ?? props.summary?.issueTracker?.key ?? null;
  const issueTitle = props.workspace.issueTitle ?? props.summary?.issueTracker?.summary ?? null;
  const issueStatus = props.summary?.issueTracker?.issueStatus ?? null;
  const [checksOpen, setChecksOpen] = useState(false);
  const checksSummary = summarizeChecks(checks);

  const recent = useQuery<WorkspaceRecentCommits>({
    queryKey: ["recent-commits", props.workspace.id, 6],
    queryFn: () => api<WorkspaceRecentCommits>(`/api/workspaces/${props.workspace.id}/recent-commits?limit=6`),
    staleTime: 30_000,
  });

  const reviewerAggregate = aggregateReviewerCounts(pr?.reviewers ?? []);

  return (
    <>
      <IssueAttachSlot
        workspaceId={props.workspace.id}
        issueKey={issueKey}
        issueTitle={issueTitle}
        issueStatus={issueStatus}
        issueUrl={issueUrl}
      />

      <div className="inspector-body">
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
                  <ReviewerAvatars reviewers={pr.reviewers} />
                  <span className="ins-pr-meta-text">
                    {reviewerAggregate.approved > 0 ? (
                      <>
                        <span className="ch-pill ch-pill-ok">{reviewerAggregate.approved}</span> approved
                      </>
                    ) : null}
                    {reviewerAggregate.changes > 0 ? (
                      <>
                        {reviewerAggregate.approved > 0 ? <span className="ins-deploy-sep">·</span> : null}
                        <span className="ch-pill ch-pill-bad">{reviewerAggregate.changes}</span> changes
                      </>
                    ) : null}
                    {reviewerAggregate.pending > 0 ? (
                      <>
                        {reviewerAggregate.approved + reviewerAggregate.changes > 0 ? (
                          <span className="ins-deploy-sep">·</span>
                        ) : null}
                        <span className="ch-pill ch-pill-mute">{reviewerAggregate.pending}</span> pending
                      </>
                    ) : null}
                    {reviewerAggregate.approved + reviewerAggregate.changes + reviewerAggregate.pending === 0 ? (
                      <span className="ins-pr-meta-empty">No reviewers assigned</span>
                    ) : null}
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
                  {checksSummary.bad > 0 ? (
                    <button
                      type="button"
                      className="cit-chip cit-chip-ghost ch-summary-rerun"
                      title="Re-run all checks"
                    >
                      <RefreshCw size={10} /> Re-run all
                    </button>
                  ) : (
                    <span className="ch-summary-rerun" />
                  )}
                </div>
                {checksOpen ? (
                  <ul className="ch-list">
                    {checks.map((check) => (
                      <CheckRow key={`${check.name}-${check.conclusion ?? check.status}`} check={check} />
                    ))}
                  </ul>
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
            ) : recent.data?.commits.length ? (
              <ul className="ins-recent">
                {recent.data.commits.map((commit) => (
                  <li key={commit.sha} title={`${commit.author} · ${commit.isoTime}`}>
                    <span className="ins-recent-sha">{commit.shortSha}</span>
                    <span className="ins-recent-msg">{commit.message}</span>
                    <span className="ins-recent-time">{shortenRelative(commit.relativeTime)}</span>
                  </li>
                ))}
              </ul>
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

function IssueAttachSlot(props: {
  workspaceId: string;
  issueKey: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  issueUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [urlDraft, setUrlDraft] = useState("");
  const keyInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open) keyInputRef.current?.focus();
  }, [open]);

  const attach = useMutation({
    mutationFn: (input: { issueKey: string; issueUrl: string | null }) =>
      api(`/api/workspaces/${props.workspaceId}`, {
        method: "PATCH",
        body: JSON.stringify({
          issueKey: input.issueKey,
          issueUrl: input.issueUrl,
          issueTitle: null,
        }),
      }),
    onSuccess: () => {
      setOpen(false);
      setKeyDraft("");
      setUrlDraft("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  if (props.issueKey) {
    return (
      <div className="inspector-attach">
        <a
          className="cit-jira"
          href={props.issueUrl ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={`Open ${props.issueKey}${props.issueTitle ? `: ${props.issueTitle}` : ""}`}
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
            <span className="cit-jira-key">{props.issueKey}</span>
            {props.issueTitle ? <span className="cit-jira-title">{props.issueTitle}</span> : null}
          </span>
          <span
            className={`cit-jira-status cit-jira-status--${props.issueStatus ? jiraStatusTone(props.issueStatus) : "unknown"}`}
            title={props.issueStatus ? `Issue status: ${props.issueStatus}` : "Status not synced"}
          >
            {props.issueStatus ?? "—"}
          </span>
        </a>
      </div>
    );
  }

  return (
    <>
      <div className="inspector-attach">
        <button
          type="button"
          className="cit-jira cit-jira--empty"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          title="Attach a Jira ticket to this workspace"
        >
          <span className="cit-jira-empty-mark" aria-hidden>
            <Plus size={11} />
          </span>
          <span className="cit-jira-empty-text">
            <span className="cit-jira-empty-title">Attach Jira ticket</span>
            <span className="cit-jira-empty-hint">link an issue to this workspace</span>
          </span>
        </button>
      </div>
      {open ? (
        <form
          className="cit-jira-attach-form"
          onSubmit={(event) => {
            event.preventDefault();
            const key = keyDraft.trim();
            if (!key) return;
            attach.mutate({ issueKey: key, issueUrl: urlDraft.trim() || null });
          }}
        >
          <label>
            Issue key
            <input
              ref={keyInputRef}
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="ABC-123"
            />
          </label>
          <label>
            Issue URL (optional)
            <input
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              placeholder="https://jira.example/browse/ABC-123"
            />
          </label>
          <div className="cit-jira-attach-actions">
            <button type="button" onClick={() => setOpen(false)} disabled={attach.isPending}>
              Cancel
            </button>
            <button type="submit" data-primary disabled={!keyDraft.trim() || attach.isPending}>
              {attach.isPending ? "Attaching…" : "Attach"}
            </button>
          </div>
        </form>
      ) : null}
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

function CheckStatusIcon({ tone, running }: { tone: "success" | "failure" | "pending"; running: boolean }) {
  if (running) {
    return (
      <span className="ch-status ch-status-run" aria-hidden>
        <Loader2 size={11} className="spin" />
      </span>
    );
  }
  if (tone === "failure") {
    return (
      <span className="ch-status ch-status-bad" aria-hidden>
        <X size={11} />
      </span>
    );
  }
  if (tone === "success") {
    return (
      <span className="ch-status ch-status-ok" aria-hidden>
        <Check size={11} />
      </span>
    );
  }
  return (
    <span className="ch-status ch-status-skip" aria-hidden>
      <Hash size={11} />
    </span>
  );
}

function splitCheckName(name: string) {
  // GitHub-style "suite / job" names show the suite separately so the eye can
  // group rows from the same workflow. Names without " / " are treated as the
  // job (no suite).
  const idx = name.indexOf(" / ");
  if (idx < 0) return { suite: null as string | null, job: name };
  return { suite: name.slice(0, idx), job: name.slice(idx + 3) };
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
  const { suite, job } = splitCheckName(check.name);
  return (
    <li
      className={`ch-row ch-row--${tone}`}
      aria-label={`${check.name} — ${label}${duration ? ` — ${duration}` : ""}`}
      title={`${check.name} — ${label}`}
    >
      <CheckStatusIcon tone={tone} running={isRunning} />
      <span className="ch-provider" title="GitHub Actions">
        <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" role="img" aria-label="GitHub Actions">
          <title>GitHub Actions</title>
          <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm3.6 6.4l-4.2 4.2a.6.6 0 01-.85 0L4.4 8.45a.6.6 0 01.85-.85l1.78 1.78L10.75 5.55a.6.6 0 01.85.85z" />
        </svg>
      </span>
      <span className="ch-name">
        {suite ? (
          <>
            <span className="ch-name-suite">{suite}</span>
            <span className="ch-name-sep">/</span>
          </>
        ) : null}
        <span className="ch-name-job" title={check.name}>
          {job}
        </span>
      </span>
      <span className="ch-time">{duration || "—"}</span>
      <span className="ch-row-action" aria-hidden />
      {check.url ? (
        <a className="ch-details" href={check.url} target="_blank" rel="noreferrer">
          Details
        </a>
      ) : (
        <span className="ch-details" style={{ visibility: "hidden" }}>
          Details
        </span>
      )}
    </li>
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
