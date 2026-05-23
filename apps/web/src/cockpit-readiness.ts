import type { AgentSession, Operation, Workspace } from "@citadel/contracts";

export type WorkspaceAttention = {
  section: string;
  label: string;
  nextAction: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
};

// Section is always derived from data that ships in /api/state (sessions,
// operations, workspace.lifecycle/dirty) — never from the per-workspace
// /cockpit-summary readiness. The summary only loads for the active workspace,
// uses richer inputs (PR checks, git conflicts, provider health), and can
// classify the same workspace as "blocked" (e.g. checks-failing,
// waiting-provider) when the local rules would call it "idle". Mixing the two
// made the active workspace's nav card jump between Blocked and Idle every
// time the summary refetched or focus moved.
export function readinessForWorkspace(
  workspace: Workspace,
  input: { sessions: AgentSession[]; operations: Operation[] },
): WorkspaceAttention {
  const failedOperation = input.operations.some((operation) => operation.status === "failed");
  const runningOperation = input.operations.some((operation) => ["queued", "running"].includes(operation.status));
  const activeAgentSession = input.sessions.some(
    (session) => session.runtimeId !== "shell" && ["starting", "waiting"].includes(session.status),
  );
  const failedSession = input.sessions.some((session) => ["failed", "orphaned"].includes(session.status));
  if (workspace.lifecycle === "failed" || failedOperation || failedSession) {
    return { section: "blocked", label: "Blocked", nextAction: "Inspect failure output", tone: "danger" };
  }
  if (workspace.lifecycle === "archived" || workspace.lifecycle === "removed") {
    return { section: "done", label: "Done", nextAction: "Archived", tone: "neutral" };
  }
  if (workspace.dirty) return { section: "dirty", label: "Dirty", nextAction: "Review diff", tone: "warning" };
  if (runningOperation || activeAgentSession) {
    return { section: "working", label: "Working", nextAction: "Follow the active agent or operation", tone: "info" };
  }
  return { section: "idle", label: "Idle", nextAction: "Start runtime", tone: "neutral" };
}

export function readinessSection(state: string) {
  if (["blocked", "checks-failing", "conflicts", "action-failed", "waiting-provider"].includes(state)) return "blocked";
  if (["needs-review", "ready-to-merge"].includes(state)) return "needs-review";
  if (["dirty"].includes(state)) return "dirty";
  if (state === "working") return "working";
  return "idle";
}

export function nextAction(workspace: Workspace, sessions: AgentSession[]) {
  if (workspace.lifecycle === "creating") return "Workspace is being created. Watch the operation status bar.";
  if (workspace.lifecycle === "failed") return "Inspect setup output and provider warnings before retrying.";
  if (!sessions.length) return "Start an agent or shell runtime to begin work in this workspace.";
  if (workspace.dirty) return "Review the diff, run checks, then prepare the PR or archive safely.";
  return "Continue from the active terminal session or open the diff for the next review pass.";
}
