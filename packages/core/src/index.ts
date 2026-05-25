import type { AgentSession, CreateWorkspaceInput, ProviderHealth, Repo, Workspace } from "@citadel/contracts";

export function nowIso() {
  return new Date().toISOString();
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
