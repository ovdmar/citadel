import type {
  AgentSession,
  CheckSummary,
  CreateWorkspaceInput,
  ProviderHealth,
  PullRequestSummary,
  Repo,
  Workspace,
} from "@citadel/contracts";

export type { PullRequestSummary } from "@citadel/contracts";

export function nowIso() {
  return new Date().toISOString();
}

// Four-tone lifecycle taxonomy shared by the workspace card status dot, the
// per-agent stage tab dot, and the navigator running-stat dot. See
// specs/B.3 item 14 for the canonical mapping.
//
//  - never-started: workspace has no non-shell agent sessions (workspace-only).
//  - running:       agent is active or between turns; navigator "in motion".
//  - done:          agent has finished cleanly (or via operator-initiated
//                   Ctrl-C / SIGTERM) and the workspace's PR (if any) has no
//                   failure-class checks.
//  - rate-limited:  agent is blocked by a server-side rate limit; it's not
//                   broken but also can't make progress until the limit
//                   resets. Rendered blue to distinguish from outright
//                   failures (red).
//  - attention:     agent failed, is blocked on input, exited badly, or the
//                   workspace's PR has at least one failing check.
export type LifecycleTone = "never-started" | "running" | "done" | "rate-limited" | "attention";

// Exit codes that signal a clean stop in operator terms. 0 is the obvious
// happy path. null appears when the wrapper never wrote a .exit sentinel
// (status monitor declared stopped via tmux gone). 130 is SIGINT (operator
// Ctrl-C) and 143 is SIGTERM (operator `make stop` or daemon shutdown) —
// painting those red would falsely accuse the operator of breaking the agent.
const CLEAN_EXIT_CODES: ReadonlySet<number> = new Set([0, 130, 143]);

// Check conclusions that escalate the workspace tone to attention. Mirrors
// `prToneFor` at apps/web/src/workspace-card.tsx:443-459 so a failing PR
// surfaces the same red dot in the navigator, stage tab strip, and card.
const FAILING_CHECK_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

// Per-agent lifecycle tone. Never returns `never-started` — that's a
// workspace-only state produced when no non-shell agent sessions exist.
export function deriveAgentLifecycleTone(
  session: Pick<AgentSession, "status" | "statusReason" | "exitCode">,
): LifecycleTone {
  switch (session.status) {
    case "starting":
    case "running":
    case "idle":
      return "running";
    case "rate_limited":
      return "rate-limited";
    case "waiting_for_input":
      return "attention";
    case "stopped": {
      const code = session.exitCode;
      if (code === null || code === undefined || CLEAN_EXIT_CODES.has(code)) return "done";
      return "attention";
    }
    case "failed":
      return "attention";
    case "unknown":
      return sessionNeedsAttention(session) ? "attention" : "running";
  }
}

function hasFailingCheck(checks: readonly CheckSummary[]): boolean {
  for (const check of checks) {
    const conclusion = check.conclusion;
    if (conclusion === null || conclusion === undefined) continue;
    if (FAILING_CHECK_CONCLUSIONS.has(conclusion.toLowerCase())) return true;
  }
  return false;
}

// Aggregate workspace tone. Order:
//   1. Filter out shell (plain-terminal) sessions.
//   2. No agents remaining → never-started.
//   3. Take the priority max of per-agent tones under
//      attention > rate-limited > running > done.
//   4. Fold PR/CI: any failing check escalates to attention, even when the
//      agent aggregate is `running`. Rationale: a failing CI is the more
//      actionable operator signal even if a fix is being authored right now.
//      Locked by the matching test in this file — do not weaken without
//      updating the spec and that test together.
export function deriveWorkspaceLifecycleTone(input: {
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
}): LifecycleTone {
  const agentSessions = input.sessions.filter((s) => s.runtimeId !== "shell");
  if (agentSessions.length === 0) return "never-started";
  let aggregate: LifecycleTone = "done";
  for (const session of agentSessions) {
    const tone = deriveAgentLifecycleTone(session);
    if (tone === "attention") {
      aggregate = "attention";
      break;
    }
    if (tone === "rate-limited") aggregate = "rate-limited";
    else if (tone === "running" && aggregate !== "rate-limited") aggregate = "running";
  }
  if (input.pullRequest && hasFailingCheck(input.pullRequest.checks)) return "attention";
  return aggregate;
}

// `status: "unknown"` reasons that indicate the agent was supposed to be
// there and isn't — render as failed-tone / attention. Indeterminate reasons
// (daemon restart, sentinel missing during boot) stay neutral so a routine
// daemon restart doesn't paint the navigator red.
const ATTENTION_UNKNOWN_REASONS: ReadonlySet<string> = new Set([
  "tmux_missing",
  "sentinel_missing_tmux_alive",
  "migrated_from_orphaned",
]);

// True iff the session needs the operator's attention — either it failed,
// or it's unknown because we have positive evidence the agent went away
// (tmux gone, sentinel mismatched). Used by readiness derivations and the
// workspace-card status dot. Single source of truth for the predicate.
export function sessionNeedsAttention(session: Pick<AgentSession, "status" | "statusReason">): boolean {
  if (session.status === "failed") return true;
  if (session.status !== "unknown") return false;
  const reason = session.statusReason;
  return reason !== null && reason !== undefined && ATTENTION_UNKNOWN_REASONS.has(reason);
}

export function createId(prefix: string) {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${prefix}_${time}_${random}`;
}

export function slugify(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "workspace";
}

export function workspaceBranchName(input: Pick<CreateWorkspaceInput, "name" | "source" | "issueKey" | "issueTitle">) {
  if (input.source === "issue" && input.issueKey) {
    const title = input.issueTitle ? `-${slugify(input.issueTitle)}` : "";
    return `${input.issueKey.toUpperCase()}${title}`.slice(0, 96);
  }
  return slugify(input.name);
}

export function repoDisplayName(rootPath: string) {
  const parts = rootPath.split("/").filter(Boolean);
  return parts.at(-1) || rootPath;
}

export function assertUniqueRepoPath(repos: Repo[], rootPath: string) {
  if (repos.some((repo) => repo.rootPath === rootPath && !repo.archivedAt)) {
    throw new Error(`Repository already registered: ${rootPath}`);
  }
}

export function assertUniqueWorkspaceName(workspaces: Workspace[], repoId: string, name: string) {
  if (workspaces.some((workspace) => workspace.repoId === repoId && workspace.name === name && !workspace.archivedAt)) {
    throw new Error(`Workspace name already exists for this repo: ${name}`);
  }
}

export function summarizeWorkspaceState(input: {
  workspace: Workspace;
  sessions: AgentSession[];
  providerHealth: ProviderHealth[];
}) {
  const activeSession = input.sessions.some((session) => session.status === "running");
  const failedSession = input.sessions.some(sessionNeedsAttention);
  const degradedProvider = input.providerHealth.some((provider) => provider.status !== "healthy");
  const suggestedSection = input.workspace.pinned
    ? input.workspace.section
    : failedSession || degradedProvider || input.workspace.lifecycle === "failed"
      ? "blocked"
      : activeSession
        ? "in-progress"
        : input.workspace.section;
  const reasons = [
    input.workspace.pinned ? "Pinned by operator" : null,
    failedSession ? "One or more sessions need attention" : null,
    degradedProvider ? "Provider data is degraded or unavailable" : null,
    activeSession ? "Agent session is active" : null,
  ].filter((reason): reason is string => Boolean(reason));
  return { suggestedSection, reasons };
}
