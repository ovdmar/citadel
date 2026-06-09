import type { AgentSession, PullRequestSummary, WorkspaceSession } from "@citadel/contracts";
import { type LifecycleTone, deriveAgentLifecycleTone } from "@citadel/core";

const SHELL_FOREGROUND_STATUSES = new Set<WorkspaceSession["status"]>(["idle", "stopped"]);
const TERMINAL_ATTENTION_STATUSES = new Set<WorkspaceSession["status"]>(["failed", "unknown"]);
const FAILING_CHECK_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required"]);

export type AttentionSessionIds = ReadonlySet<string>;

export function workspaceCardSessions(
  sessions: readonly WorkspaceSession[],
  workspaceId: string,
  checkouts: readonly { id: string }[],
): WorkspaceSession[] {
  const checkoutIds = new Set(checkouts.map((checkout) => checkout.id));
  const seen = new Set<string>();
  const result: WorkspaceSession[] = [];
  for (const session of sessions) {
    if (session.closedAt) continue;
    const belongsToWorkspace = session.workspaceId === workspaceId;
    const belongsToCheckout = Boolean(session.checkoutId && checkoutIds.has(session.checkoutId));
    if (!belongsToWorkspace && !belongsToCheckout) continue;
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    result.push(session);
  }
  return result;
}

export function sessionAttentionFingerprint(session: WorkspaceSession): string | null {
  if (session.kind !== "agent") return null;
  const tone = deriveAgentLifecycleTone(session);
  if (tone === "running") return null;
  const statusAt = session.lastStatusAt ?? session.updatedAt ?? session.createdAt;
  return [session.status, session.statusReason ?? "", session.statusReasonAt ?? "", statusAt, session.exitCode ?? ""]
    .map(String)
    .join("|");
}

export function deriveSessionDisplayLifecycleTone(
  session: WorkspaceSession,
  unseenAttentionSessionIds?: AttentionSessionIds,
): LifecycleTone {
  if (session.kind === "terminal") return deriveTerminalLifecycleTone(session);
  const baseTone = deriveAgentLifecycleTone(session);
  const hasAttentionFingerprint = sessionAttentionFingerprint(session) !== null;
  if (hasAttentionFingerprint && unseenAttentionSessionIds?.has(session.id)) return "attention";
  if (hasAttentionFingerprint && baseTone === "attention") return "done";
  return baseTone;
}

export function deriveTerminalLifecycleTone(session: WorkspaceSession): LifecycleTone {
  if (session.kind !== "terminal") return deriveAgentLifecycleTone(session);
  if (session.status === "starting" || session.status === "running") return "running";
  if (TERMINAL_ATTENTION_STATUSES.has(session.status)) return "attention";
  if (SHELL_FOREGROUND_STATUSES.has(session.status)) return "done";
  return "attention";
}

export function deriveWorkspaceDisplayLifecycleTone(input: {
  sessions: WorkspaceSession[];
  pullRequest?: PullRequestSummary | null;
  unseenAttentionSessionIds?: AttentionSessionIds | undefined;
}): LifecycleTone {
  const agentSessions = input.sessions.filter((session): session is AgentSession => session.kind === "agent");
  if (agentSessions.length === 0) return "never-started";

  let aggregate: LifecycleTone = "done";
  for (const session of agentSessions) {
    const tone = deriveSessionDisplayLifecycleTone(session, input.unseenAttentionSessionIds);
    if (tone === "attention") return "attention";
    if (tone === "running") aggregate = "running";
  }
  if (input.pullRequest && pullRequestNeedsAttention(input.pullRequest)) return "attention";
  return aggregate;
}

export function pullRequestNeedsAttention(pr: PullRequestSummary): boolean {
  if (pr.mergeable === "conflicting" || pr.mergeStateStatus === "DIRTY") return true;
  for (const check of pr.checks) {
    const conclusion = check.conclusion;
    if (conclusion && FAILING_CHECK_CONCLUSIONS.has(conclusion.toLowerCase())) return true;
  }
  return false;
}
