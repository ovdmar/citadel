import type { PullRequestSummary, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  GitPullRequest,
  Hash,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { ReviewerAvatars, aggregateReviewerCounts } from "./inspector-reviewers.js";
import { formatLabel } from "./labels.js";
import { prToneFor } from "./workspace-card.js";

export function InspectorPrSection(props: {
  workspace: Workspace;
  pr: PullRequestSummary | null;
  diffFiles: number;
  diffAdded: number;
  diffRemoved: number;
  checkedAt: string | undefined;
}) {
  const { workspace, pr, diffFiles, diffAdded, diffRemoved, checkedAt } = props;
  const prTone = prToneFor(pr);
  const checks = pr?.checks ?? [];
  const [checksOpen, setChecksOpen] = useState(false);
  const checksSummary = summarizeChecks(checks);
  const reviewerAggregate = aggregateReviewerCounts(pr?.reviewers ?? []);
  const elapsed = useElapsed(checkedAt);
  const [commitsExpanded, setCommitsExpanded] = useState(false);
  const commits = pr?.commits ?? [];
  const visibleCommits = commitsExpanded ? commits : commits.slice(0, 5);
  const refresh = useMutation({
    mutationFn: () => api(`/api/workspaces/${workspace.id}/pr-refresh`, { method: "POST", body: JSON.stringify({}) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspaces-pr-batch"] });
    },
  });
  // Copies the PR's head ref (from gh) — NOT workspace.branch. If the local
  // branch was renamed but the PR head hasn't moved, the operator pastes the
  // correct ref into `git push origin <ref>` and friends.
  const headRef = pr?.headRefName ?? workspace.branch;
  const copyHead = () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(headRef);
  };

  return (
    <>
      <section className="ins-section">
        <div className="ins-section-head">
          <span className="ins-section-label">Pull request</span>
        </div>
        <div className="ins-section-body">
          {pr ? (
            <div className="ins-pr">
              {pr.parentPr ? (
                <a
                  className="ins-pr-parent"
                  href={pr.parentPr.url}
                  target="_blank"
                  rel="noreferrer"
                  data-state={pr.parentPr.state.toLowerCase() === "merged" ? "merged" : "open"}
                  title={`Parent PR #${pr.parentPr.number} (${pr.parentPr.state})`}
                >
                  <ArrowUp size={10} /> #{pr.parentPr.number}
                </a>
              ) : null}
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
                  <span className="ins-mono">{workspace.baseBranch}</span>
                  <span className="ins-pr-arrow">←</span>
                  <span className="ins-mono">{headRef}</span>
                  <button
                    type="button"
                    className="ins-pr-copy"
                    onClick={copyHead}
                    aria-label={`Copy head branch ${headRef}`}
                    title={`Copy head branch ${headRef}`}
                  >
                    <Copy size={10} />
                  </button>
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
          {checkedAt ? (
            <span className="ins-pr-elapsed" title={`Last fetched ${new Date(checkedAt).toLocaleString()}`}>
              {elapsed} ago
            </span>
          ) : null}
          <button
            type="button"
            className="ch-toggle ins-pr-refresh"
            onClick={() => refresh.mutate()}
            disabled={refresh.isPending}
            aria-label="Force-refresh PR and check state"
            title="Force-refresh PR and check state"
          >
            <RefreshCw size={11} className={refresh.isPending ? "spin" : undefined} />
          </button>
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
                  <button type="button" className="cit-chip cit-chip-ghost ch-summary-rerun" title="Re-run all checks">
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

      {pr ? (
        <section className="ins-section">
          <div className="ins-section-head">
            <span className="ins-section-label">Commits</span>
          </div>
          <div className="ins-section-body">
            {commits.length === 0 ? (
              <div className="ins-empty">
                <div className="ins-empty-text">No commits yet.</div>
              </div>
            ) : (
              <>
                <ul className="ins-pr-commits">
                  {visibleCommits.map((commit) => (
                    <li key={commit.sha} className="ins-pr-commit" title={commit.message}>
                      <span className={`ins-pr-commit-dot tone-${commitTone(commit.checks)}`} aria-hidden />
                      <span className="ins-pr-commit-sha">{commit.shortSha}</span>
                      <span className="ins-pr-commit-msg">{commit.message}</span>
                    </li>
                  ))}
                </ul>
                {commits.length > 5 ? (
                  <button type="button" className="ins-pr-commits-more" onClick={() => setCommitsExpanded((v) => !v)}>
                    {commitsExpanded ? "Show fewer" : `Show ${commits.length - 5} more`}
                  </button>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}
    </>
  );
}

// Roll up the per-commit checks into a single tone for the dot. Mirror the
// PR-level prToneFor logic: failing > pending > passing.
function commitTone(
  checks: PullRequestSummary["commits"][number]["checks"],
): "failing" | "pending" | "passing" | "missing" {
  if (!checks || checks.length === 0) return "missing";
  if (
    checks.some((c) =>
      ["failure", "cancelled", "timed_out", "action_required"].includes((c.conclusion ?? "").toLowerCase()),
    )
  ) {
    return "failing";
  }
  if (checks.some((c) => ["queued", "in_progress", "pending"].includes(c.status.toLowerCase()))) {
    return "pending";
  }
  if (checks.every((c) => (c.conclusion ?? "").toLowerCase() === "success")) return "passing";
  return "pending";
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

export function summarizeChecks(checks: Array<{ status: string; conclusion: string | null }>) {
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

// "Last fetched X ago" auto-tick. Re-renders every minute so the displayed
// elapsed string doesn't go stale while the inspector is open. Returns a
// short string like "30s", "5m", "2h" — matches the visual density of
// other ins-* timestamps.
function useElapsed(isoTime: string | undefined): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isoTime) return;
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [isoTime]);
  if (!isoTime) return "";
  const then = Date.parse(isoTime);
  if (!Number.isFinite(then)) return "";
  return formatDurationMs(Math.max(0, now - then));
}

