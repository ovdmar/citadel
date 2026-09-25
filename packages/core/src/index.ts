import type {
  AgentSession,
  CheckSummary,
  CreateWorkspaceInput,
  ProviderHealth,
  PullRequestSummary,
  Repo,
  Workspace,
  WorkspaceSession,
} from "@citadel/contracts";

export type { PullRequestSummary } from "@citadel/contracts";

export function nowIso() {
  return new Date().toISOString();
}

// Four-tone lifecycle taxonomy shared by the workspace card status dot, the
// per-agent stage tab dot, and the navigator running-stat dot. See
// specs/B.3 item 14 for the canonical mapping.
//
//  - never-started: workspace has no agent sessions (workspace-only).
//  - running:       agent is actively starting or running.
//  - done:          agent has finished cleanly (or via operator-initiated
//                   Ctrl-C / SIGTERM) and the workspace's PR (if any) has no
//                   failure-class checks.
//  - attention:     agent failed, is blocked on input or limits, exited badly,
//                   has conflicts, or the workspace's PR has failing checks.
export type LifecycleTone = "never-started" | "running" | "done" | "attention";

// Exit codes that signal a clean stop in operator terms. 0 is the obvious
// happy path. null appears when the wrapper never wrote a .exit sentinel
// (status monitor declared stopped via tmux gone). 130 is SIGINT (operator
// Ctrl-C) and 143 is SIGTERM (operator `make stop` or daemon shutdown) —
// painting those red would falsely accuse the operator of breaking the agent.
const CLEAN_EXIT_CODES: ReadonlySet<number> = new Set([0, 130, 143]);

// Check conclusions that escalate the workspace tone to attention. Mirrors
// `prToneFor` in apps/web/src/workspace-card.tsx so a failing PR surfaces the
// same red dot in the navigator, stage tab strip, and card.
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
      return "running";
    case "idle":
      return sessionNeedsAttention(session) ? "attention" : "done";
    case "rate_limited":
    case "usage_limited":
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

function prNeedsAttention(pr: PullRequestSummary): boolean {
  return pr.mergeable === "conflicting" || pr.mergeStateStatus === "DIRTY" || hasFailingCheck(pr.checks);
}

// Aggregate workspace tone. Order:
//   1. Filter out plain terminal sessions.
//   2. No agents remaining → never-started.
//   3. Take the priority max of per-agent tones under
//      attention > running > done.
//   4. Fold PR/CI: any failing check or conflict escalates to attention, even
//      when the agent aggregate is `running`. Rationale: a failing CI/conflict
//      is the more actionable operator signal even if a fix is being authored.
//      Locked by the matching test in this file — do not weaken without
//      updating the spec and that test together.
export function deriveWorkspaceLifecycleTone(input: {
  sessions: WorkspaceSession[];
  pullRequest?: PullRequestSummary | null;
}): LifecycleTone {
  const agentSessions = input.sessions.filter((s): s is AgentSession => s.kind === "agent");
  if (agentSessions.length === 0) return "never-started";
  let aggregate: LifecycleTone = "done";
  for (const session of agentSessions) {
    const tone = deriveAgentLifecycleTone(session);
    if (tone === "attention") {
      aggregate = "attention";
      break;
    }
    if (tone === "running") aggregate = "running";
  }
  if (input.pullRequest && prNeedsAttention(input.pullRequest)) return "attention";
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

// `status: "idle"` reasons that indicate the agent crashed or exited
// without operator intervention — surfaces a red attention pulse so the
// "your agent died" signal isn't lost (per shell-first-panes spec B.3 #8).
// Pairs with the 30-min auto-clear in the status-monitor.
const ATTENTION_IDLE_REASONS: ReadonlySet<string> = new Set(["idle_after_unexpected_exit"]);

// True iff the session needs the operator's attention — either it failed,
// or it's unknown because we have positive evidence the agent went away
// (tmux gone, sentinel mismatched), or it crashed mid-session
// (idle_after_unexpected_exit). Used by readiness derivations and the
// workspace-card status dot. Single source of truth for the predicate.
export function sessionNeedsAttention(session: Pick<AgentSession, "status" | "statusReason">): boolean {
  if (session.status === "failed") return true;
  if (
    session.status === "waiting_for_input" ||
    session.status === "rate_limited" ||
    session.status === "usage_limited"
  ) {
    return true;
  }
  const reason = session.statusReason;
  if (session.status === "unknown") {
    return reason !== null && reason !== undefined && ATTENTION_UNKNOWN_REASONS.has(reason);
  }
  if (session.status === "idle") {
    return reason !== null && reason !== undefined && ATTENTION_IDLE_REASONS.has(reason);
  }
  return false;
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
  sessions: WorkspaceSession[];
  providerHealth: ProviderHealth[];
}) {
  const agentSessions = input.sessions.filter((session): session is AgentSession => session.kind === "agent");
  const activeSession = agentSessions.some((session) => session.status === "running");
  const failedSession = agentSessions.some(sessionNeedsAttention);
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

export { groupChecksByKind, statusLabel, summarizeDoctor } from "./doctor.js";
export { FUNNY_ADJECTIVES, FUNNY_ANIMALS, generateFunnyName } from "./funny-name.js";
export {
  LaunchTextValidationError,
  assertNoRawAgentAuthorityToken,
  containsRawAgentAuthorityToken,
  type LaunchTextValidationContext,
  type LaunchTextValidationErrorCode,
} from "./agent-authority-token.js";
export {
  type FuzzyBlockMatch,
  type FuzzyMatchIndex,
  SEARCH_LIMITS,
  buildFuzzyIndex,
  fuzzySearchBlocks,
} from "./scratchpad-search.js";
