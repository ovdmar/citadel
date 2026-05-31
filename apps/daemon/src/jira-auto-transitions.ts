// Lifecycle-event-driven Jira auto-transitions.
//
// Wired as an injected callback into the operations layer (not as a daemon
// SSE listener — see the tech plan: agent.started fires from
// packages/operations/src/create-agent-session.ts, not from the daemon's
// SSE `emit`). The factory below produces the callback; the daemon passes
// it into OperationService construction (for agent + archive/remove events)
// and into the workspace-PATCH handler (for workspace.issue_attached).
//
// Invariants the implementation relies on:
//  1. `transition` in config names the TARGET STATUS the issue should end
//     up in (e.g., "In Progress"), not the underlying Jira transition name.
//     resolveJiraTransitionByTargetStatus matches by toStatus.
//  2. The callback re-reads `workspace.issueKey` from the store at dispatch
//     time, not at registration, so an unattach between the originating
//     operation and this callback is safe.
//  3. Idempotency: if the issue is already in the target status, we skip
//     the call (avoids burst on agent restart). The check is a string
//     compare against the cached IssueTrackerSummary's `issueStatus`.
//  4. SSE re-emit uses a DISTINCT event name `provider.issue_transition.auto`
//     to prevent a future operations-layer subscriber to
//     `provider.issue_transition` from feedback-looping into another
//     auto-transition. The cockpit listens for both.
//  5. Failures never throw out — the originating operation must not be
//     surfaced to the user as if it failed. Everything is logged to
//     activity_events.

import type { CitadelConfig } from "@citadel/config";
import type { AgentSession, HookOutput, JiraAutoTransitionEvent, Repo, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import {
  type collectJiraIssueSummary as collectJiraIssueSummaryType,
  resolveJiraTransitionByTargetStatus,
  type transitionJiraIssue as transitionJiraIssueType,
} from "@citadel/providers";

// Internal — daemon callers consume this via wireJiraAutoTransitions. The
// operations layer's public RunAutoTransitionsDep type is the cross-
// package contract; this is the daemon-side shape.
type RunAutoTransitions = (
  event: JiraAutoTransitionEvent,
  repo: Repo,
  workspace: Workspace,
  payload: { repo: Repo; workspace: Workspace; session?: AgentSession },
) => Promise<void>;

type Activity = (
  type: string,
  source: "user" | "system" | "hook",
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
  hookOutput?: HookOutput | null,
) => void;

type Emit = (type: string, payload: unknown) => void;

type CreateJiraAutoTransitionsDeps = {
  config: CitadelConfig;
  providers: {
    collectJiraIssueSummary: typeof collectJiraIssueSummaryType;
    transitionJiraIssue: typeof transitionJiraIssueType;
    resolveJiraTransitionByTargetStatus: typeof resolveJiraTransitionByTargetStatus;
  };
  store: SqliteStore;
  activity: Activity;
  emit: Emit;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
};

// Thin wrapper for the daemon's typical wiring: takes the providers
// snapshot from createDaemonApp and supplies the boilerplate activity +
// resolver. Lives here so app.ts stays under the 800-line file-size gate.
export function wireJiraAutoTransitions(input: {
  config: CitadelConfig;
  providers: {
    collectJiraIssueSummary: typeof collectJiraIssueSummaryType;
    transitionJiraIssue: typeof transitionJiraIssueType;
  };
  store: SqliteStore;
  emit: Emit;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
}): RunAutoTransitions {
  const { config, providers, store, emit, providerCache } = input;
  return createJiraAutoTransitions({
    config,
    providers: {
      collectJiraIssueSummary: providers.collectJiraIssueSummary,
      transitionJiraIssue: providers.transitionJiraIssue,
      resolveJiraTransitionByTargetStatus,
    },
    store,
    activity: (type, source, message, repoId, workspaceId, operationId) =>
      store.addActivity({
        id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        type,
        source,
        repoId,
        workspaceId,
        operationId,
        message,
        hookOutput: null,
        createdAt: new Date().toISOString(),
      }),
    emit,
    providerCache,
  });
}

export function createJiraAutoTransitions(deps: CreateJiraAutoTransitionsDeps): RunAutoTransitions {
  const { config, providers, store, activity, emit, providerCache } = deps;

  return async function runAutoTransitions(event, _repo, workspace, _payload) {
    try {
      const entries = config.providers.jira.autoTransitions.filter((entry) => entry.event === event);
      if (entries.length === 0) return;

      // For events that fire on a workspace that's still active, re-read
      // from the store so a post-emit unattach is honoured. Archive/remove
      // events fire AFTER the workspace has been archived or deleted, so
      // listWorkspaces() (which filters archived_at IS NULL) would return
      // nothing and the auto-transition would silently never fire — trust
      // the snapshot's issueKey for those two events instead.
      const honourSnapshot = event === "workspace.archived" || event === "workspace.removed";
      const current = honourSnapshot ? workspace : (store.listWorkspaces().find((w) => w.id === workspace.id) ?? null);
      const issueKey = current?.issueKey ?? null;
      if (!issueKey) return;

      for (const entry of entries) {
        const target = entry.transition;
        // Fresh summary read (cached path delegated to caller via the
        // providerCache map invalidation below). For now, read directly so
        // we always see the current status — the picker's cache TTL is the
        // backstop against thrash.
        const summary = await providers.collectJiraIssueSummary(issueKey);
        if (summary.status === "degraded") {
          activity(
            "provider.issue_transition.auto",
            "system",
            `Auto-transition skipped: Jira summary degraded for ${issueKey} (${summary.reason ?? "unknown reason"})`,
            workspace.repoId,
            workspace.id,
            null,
          );
          continue;
        }

        const currentStatus = (summary.issueStatus ?? "").trim().toLowerCase();
        const targetLower = target.trim().toLowerCase();
        if (currentStatus && currentStatus === targetLower) {
          activity(
            "provider.issue_transition.auto.skip",
            "system",
            `Auto-transition idempotent skip: ${issueKey} already in "${summary.issueStatus}"`,
            workspace.repoId,
            workspace.id,
            null,
          );
          continue;
        }

        const transitionId = providers.resolveJiraTransitionByTargetStatus(summary.transitions, target);
        if (!transitionId) {
          activity(
            "provider.issue_transition.auto.unresolved",
            "system",
            `Auto-transition unresolved: no available transition leads to "${target}" from "${summary.issueStatus ?? "unknown"}" on ${issueKey}`,
            workspace.repoId,
            workspace.id,
            null,
          );
          continue;
        }

        const result = await providers.transitionJiraIssue({ issueKey, transition: transitionId });
        providerCache.delete(`issue:${issueKey}`);
        activity(
          "provider.issue_transition.auto",
          "system",
          result.status === "healthy"
            ? `Auto-transitioned ${issueKey} → "${target}" on ${event}`
            : `Auto-transition failed for ${issueKey} → "${target}" on ${event}: ${result.reason ?? "unknown"}`,
          workspace.repoId,
          workspace.id,
          null,
        );
        emit("provider.issue_transition.auto", {
          workspaceId: workspace.id,
          issueKey,
          event,
          target,
          result,
        });
      }
    } catch (error) {
      // Never throw out — the originating operation (agent start, workspace
      // archive, etc.) must not surface this to the user as a failure.
      activity(
        "provider.issue_transition.auto.error",
        "system",
        `Auto-transition listener crashed for ${event} on workspace ${workspace.id}: ${
          error instanceof Error ? error.message : "unknown"
        }`,
        workspace.repoId,
        workspace.id,
        null,
      );
    }
  };
}
