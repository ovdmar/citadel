import type { WorkspaceReadiness } from "@citadel/contracts";
import { sessionNeedsAttention } from "@citadel/core";

export function deriveReadiness(input: {
  workspace: { lifecycle: string; dirty: boolean };
  sessions: Array<{ status: string; runtimeId?: string; statusReason?: string | null | undefined }>;
  operations: Array<{ status: string; type: string; error: string | null }>;
  providerHealth: Array<{ status: string; reason: string | null }>;
  git: { clean: boolean; conflicted: number; modified: number; staged: number; untracked: number; checkedAt: string };
  versionControl: {
    status: string;
    reason: string | null;
    pullRequest: {
      draft: boolean;
      reviewDecision: string | null;
      checks: Array<{ status: string; conclusion: string | null }>;
    } | null;
    checkedAt: string;
  };
  ci: {
    status: string;
    reason: string | null;
    runs: Array<{ conclusion: string | null; status: string }>;
    checkedAt: string;
  };
  apps: { status: string; reason: string | null; actions: unknown[] };
}): WorkspaceReadiness {
  const checkedAt = new Date().toISOString();
  const failedOperation = input.operations.find((operation) => operation.status === "failed");
  const failingCheck = input.versionControl.pullRequest?.checks.some((check) =>
    ["failure", "cancelled", "timed_out", "action_required"].includes(String(check.conclusion ?? "").toLowerCase()),
  );
  const pendingCheck = input.versionControl.pullRequest?.checks.some((check) =>
    ["queued", "in_progress", "pending"].includes(String(check.status).toLowerCase()),
  );
  const degraded =
    input.versionControl.status !== "healthy" || input.ci.status !== "healthy" || input.apps.status !== "healthy";
  const runningOperation = input.operations.some((operation) => ["queued", "running"].includes(operation.status));
  const activeAgentSession = input.sessions.some(
    (session) => session.runtimeId !== "shell" && ["starting", "running"].includes(session.status),
  );
  // Loose-typed (this signature accepts plain strings); cast to the canonical
  // shape for the shared predicate. Any non-canonical status will return false.
  const failedSession = input.sessions.some((session) =>
    sessionNeedsAttention({ status: session.status as never, statusReason: session.statusReason ?? null }),
  );
  const reasons = [
    input.workspace.lifecycle === "failed" ? "Workspace lifecycle failed" : null,
    failedSession ? "A terminal or agent session needs attention" : null,
    failedOperation ? failedOperation.error || `${failedOperation.type} failed` : null,
    input.git.conflicted ? `${input.git.conflicted} conflicted files` : null,
    failingCheck ? "One or more PR checks are failing" : null,
    pendingCheck ? "PR checks are still running" : null,
    degraded ? "Provider, hook, or app data is degraded" : null,
    !input.git.clean ? "Working tree has local changes" : null,
    runningOperation || activeAgentSession ? "An agent or operation is actively working" : null,
  ].filter((reason): reason is string => Boolean(reason));

  if (input.workspace.lifecycle === "failed" || failedSession || failedOperation) {
    return readiness(
      "blocked",
      "danger",
      "Open failure output and decide whether to retry or archive",
      reasons,
      checkedAt,
      degraded,
    );
  }
  if (input.git.conflicted) {
    return readiness(
      "conflicts",
      "danger",
      "Resolve conflicts before reviewing or deploying",
      reasons,
      checkedAt,
      degraded,
    );
  }
  if (failingCheck)
    return readiness(
      "checks-failing",
      "danger",
      "Inspect failing checks and fix the branch",
      reasons,
      checkedAt,
      degraded,
    );
  if (degraded)
    return readiness(
      "waiting-provider",
      "warning",
      "Refresh providers or inspect hook diagnostics",
      reasons,
      checkedAt,
      true,
    );
  if (!input.git.clean)
    return readiness("dirty", "warning", "Review the diff and prepare the PR", reasons, checkedAt, false);
  if (input.versionControl.pullRequest?.reviewDecision === "APPROVED" && !pendingCheck) {
    return readiness(
      "ready-to-merge",
      "success",
      "Review final context and merge outside Citadel",
      reasons,
      checkedAt,
      false,
    );
  }
  if (input.versionControl.pullRequest)
    return readiness("needs-review", "info", "Review PR, checks, and latest diff", reasons, checkedAt, false);
  if (runningOperation || activeAgentSession)
    return readiness("working", "info", "Follow the active agent or operation", reasons, checkedAt, false);
  return readiness("idle", "neutral", "Start a runtime or open the workspace actions", reasons, checkedAt, false);
}

function readiness(
  state: WorkspaceReadiness["state"],
  tone: WorkspaceReadiness["tone"],
  nextAction: string,
  reasons: string[],
  checkedAt: string,
  degraded: boolean,
): WorkspaceReadiness {
  return { state, tone, nextAction, reasons, freshness: { checkedAt, stale: false, degraded } };
}

export function workspaceAppHookSample() {
  return {
    applications: [
      {
        id: "preview",
        label: "Preview",
        kind: "preview",
        url: "https://preview.example.internal",
        environment: "dev",
        status: "healthy",
        version: "optional version",
        commit: "optional commit",
        updatedAt: new Date().toISOString(),
        metadata: {},
      },
    ],
    links: [{ label: "Runbook", url: "https://docs.example.internal", kind: "docs" }],
    actions: [
      {
        id: "redeploy",
        label: "Redeploy",
        kind: "redeploy",
        safety: "confirm",
        executable: true,
        metadata: {},
      },
    ],
    metadata: {},
  };
}
