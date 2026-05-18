import type { AgentSession, Operation, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { formatLabel } from "./labels.js";

export type WorkspaceAttention = {
  section: string;
  label: string;
  nextAction: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
};

export function readinessForWorkspace(
  workspace: Workspace,
  input: { sessions: AgentSession[]; operations: Operation[]; summary: WorkspaceCockpitSummary | undefined },
): WorkspaceAttention {
  if (input.summary) {
    return {
      section: readinessSection(input.summary.readiness.state),
      label: formatLabel(input.summary.readiness.state),
      nextAction: input.summary.readiness.nextAction,
      tone: input.summary.readiness.tone,
    };
  }
  const failedOperation = input.operations.some((operation) => operation.status === "failed");
  const activeSession = input.sessions.some((session) => ["running", "waiting"].includes(session.status));
  const failedSession = input.sessions.some((session) => ["failed", "orphaned"].includes(session.status));
  if (workspace.lifecycle === "failed" || failedOperation || failedSession) {
    return { section: "blocked", label: "Blocked", nextAction: "Inspect failure output", tone: "danger" };
  }
  if (workspace.lifecycle === "archived" || workspace.lifecycle === "removed") {
    return { section: "done", label: "Done", nextAction: "Archived", tone: "neutral" };
  }
  if (workspace.dirty) return { section: "dirty", label: "Dirty", nextAction: "Review diff", tone: "warning" };
  if (activeSession) return { section: "working", label: "Working", nextAction: "Continue session", tone: "info" };
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
