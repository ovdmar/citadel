import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig, HookConfig } from "@citadel/config";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
import type { ActivityEvent, AgentSession, CheckoutContextInput, CreateAgentSessionInput, CreateNamespaceInput, CreateTerminalSessionInput, CreateWorkspaceCheckoutInput, CreateWorkspaceInput, HookAction, HookEvent, HookOutput, JiraAutoTransitionEvent, LaunchAgentInput, MarkCheckoutReadyForReviewInput, Namespace, Operation, PlanDeviationReport, RegisterCheckoutReviewArtifactInput, RegisterWorkspacePlanInput, Repo, UpdateNamespaceInput, UpdateTicketStatusInput, Workspace, WorkspaceManagerControlInput, WorktreeCheckout } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";
import * as agentHistory from "./agent-history.js";
import * as agentMessages from "./agent-messages.js";
import {
  type RuntimeDescriptor,
  createAgentSession as createAgentSessionImpl,
  createTerminalSession as createTerminalSessionImpl,
} from "./create-agent-session.js";
import { type CreateWorkspaceOptions, type WorkspaceOpsDeps, createWorkspaceImpl } from "./create-workspace.js";
import { launchAgent as launchAgentImpl } from "./launch-agent.js";
import * as namespaceOps from "./namespaces.js";
import { registerRepo as registerRepoImpl } from "./register-repo.js";
import { checkWorkspaceRemovalImpl, removeWorkspaceCheckoutImpl, removeWorkspaceImpl } from "./remove-workspace.js";
import type { CreateAgentSessionOperationInput } from "./system-prompt-launch.js";
export type { TranscriptResult, TranscriptErrorResult, SendMessageResult } from "./agent-messages.js";
export type { RuntimeDescriptor } from "./create-agent-session.js";
export type { LaunchAgentResult } from "./launch-agent.js";
export type { CreateAgentSessionOperationInput } from "./system-prompt-launch.js";
export type { AssignWorkspaceResult, CreateNamespaceResult } from "./namespaces.js";
export type { AgentHistoryResult, AgentHistoryErrorResult } from "./agent-history.js";
export * from "./status.js";
export {
  ScheduledAgentRunner,
  parseCronExpression,
  cronMatches,
  nextCronRun,
  describeCron,
} from "./scheduled-agents.js";
export { MAX_QUEUED_RUNS_PER_AGENT } from "./scheduled-agents.js";
export type { CronExpression, ScheduledAgentRunResult, ScheduledAgentDeps } from "./scheduled-agents.js";
export { createBackgroundAgentSession } from "./create-background-agent-session.js";
export { executionTargetCwd, resolveExecutionTargetForCwd, workspaceRootPath } from "./workspace-layout.js";
export {
  executeWorkspaceLayoutMigration,
  hasWorkspaceLayoutMigrationCandidates,
  planWorkspaceLayoutMigration,
  runWorkspaceLayoutMigrations,
} from "./workspace-layout-migration.js";
export type {
  CheckoutGateSnapshot,
  MarkCheckoutReadyForReviewResult,
  RegisterCheckoutReviewArtifactResult,
  WorkspaceManagerControlResult,
  WorkspaceManagerTickResult,
} from "./workspace-manager.js";
export type { CitadelContextResult, RegisterWorkspacePlanResult, WorkspacePlanSnapshot } from "./workspace-plans.js";
export type {
  WorkspaceGitSnapshot,
  WorkspaceLayoutMigrationPlan,
  WorkspaceLayoutMigrationSkipReason,
} from "./workspace-layout-migration.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { createDiagnosticsLogger, noopDiagnosticsLogger, type DiagnosticEvent, type DiagnosticsLogger, type DiagnosticsLoggerOptions } from "./diagnostics.js";
export { parseUsageLimitResetFromReason, deriveAccountUsageLimit, type AccountRateLimitInfo } from "./usage-limit.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { DEFAULT_AUTO_RESUME_INTERVAL_MS, startAutoResumeLoop, type AutoResumeDeps, type AutoResumeLoopHandle } from "./auto-resume.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
import { type DeployOpsDeps, listDeployedApps as listDeployedAppsImpl, redeployApp as redeployAppImpl, undeployApp as undeployAppImpl } from "./deploy.js";
import { cancelOperationInStore, listHookDiagnostics, reconcileStore, tryRunGit } from "./helpers.js";

// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { BranchInUseByWorktreeError, RemoteRefMissingError, WorkspaceInUseError, WorkspaceNameTakenError } from "./helpers.js";
import { buildDispatchAgentHookDeps, dispatchAgentHook as dispatchAgentHookImpl } from "./dispatch-agent-hook.js";
import { type DispatchAgentHook, runNotificationHooks, runWorkspaceHooks } from "./hooks-runner.js";
import { createWorkspaceCheckoutImpl } from "./structured-workspace.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
import { type WorkspaceAppsDeps, discoverWorkspaceApps as discoverWorkspaceAppsImpl, runWorkspaceAction as runWorkspaceActionImpl } from "./workspace-apps.js";
import {
  hasWorkspaceLayoutMigrationCandidates,
  runWorkspaceLayoutMigrations as runWorkspaceLayoutMigrationsImpl,
} from "./workspace-layout-migration.js";
import * as workspaceManager from "./workspace-manager.js";
import * as workspacePlans from "./workspace-plans.js";

// Daemon-constructed callback that fires lifecycle-event-driven Jira
// transitions. Optional — when not wired (e.g., unit tests that don't
// involve Jira), all auto-transition paths short-circuit.
export type RunAutoTransitionsDep = (
  event: JiraAutoTransitionEvent,
  repo: Repo,
  workspace: Workspace,
  payload: { repo: Repo; workspace: Workspace; session?: AgentSession },
) => Promise<void>;

export function defaultWorktreeParent(rootPathInput: string, dataDir?: string): string {
  const rootPath = path.resolve(rootPathInput);
  const repoDir = path.basename(rootPath);
  if (dataDir) return path.join(dataDir, "worktrees", repoDir);
  return path.join(path.dirname(rootPath), `${repoDir}-worktrees`);
}

function deployActionInflightKey(workspaceId: string, checkoutId: string | null | undefined): string {
  return checkoutId ? `${workspaceId}:checkout:${checkoutId}` : `${workspaceId}:home`;
}

function workspaceForCheckout(workspace: Workspace, checkout: WorktreeCheckout): Workspace {
  return {
    ...workspace,
    repoId: checkout.repoId,
    name: checkout.displayName ?? checkout.name,
    path: checkout.path,
    branch: checkout.branch,
    baseBranch: checkout.baseBranch,
    kind: "worktree",
    issueKey: checkout.issue?.key ?? workspace.issueKey,
    issueTitle: checkout.issue?.title ?? workspace.issueTitle,
    issueUrl: checkout.issue?.url ?? workspace.issueUrl,
    updatedAt: checkout.updatedAt,
  };
}

export class OperationService {
  constructor(
    private readonly store: SqliteStore,
    private readonly config?: {
      dataDir?: string;
      hooks: HookConfig[];
      repoDefaults: {
        setupHookIds: string[];
        teardownHookIds: string[];
        appHookIds?: string[];
        actionHookIds?: string[];
      };
      commandPolicy: CitadelConfig["commandPolicy"];
      terminal?: CitadelConfig["terminal"];
      agentRuntimes?: CitadelConfig["agentRuntimes"];
      agentSessions?: CitadelConfig["agentSessions"];
    },
    private readonly runAutoTransitionsDep: RunAutoTransitionsDep | null = null,
  ) {}

  registerRepo(input: { rootPath: string; name?: string | undefined; worktreeParent?: string | undefined }) {
    const repoDefaults = this.config?.repoDefaults;
    return registerRepoImpl(
      {
        store: this.store,
        ...(repoDefaults ? { repoDefaults } : {}),
        activity: (...args) => this.activity(...args),
      },
      {
        ...input,
        worktreeParent: input.worktreeParent || defaultWorktreeParent(input.rootPath, this.config?.dataDir),
      },
    );
  }

  createWorkspace = (input: CreateWorkspaceInput, options?: CreateWorkspaceOptions) =>
    createWorkspaceImpl(this.workspaceOpsDeps(), input, options);

  createWorkspaceCheckout = (input: CreateWorkspaceCheckoutInput) =>
    createWorkspaceCheckoutImpl(this.workspaceOpsDeps(), input);

  registerWorkspacePlan = (input: RegisterWorkspacePlanInput, options?: { actor?: workspacePlans.TrustedToolActor }) =>
    workspacePlans.registerWorkspacePlan(this.planDeps(), input, options);

  getWorkspacePlan = (input: { workspaceId?: string | undefined; cwd?: string | undefined }) =>
    workspacePlans.getWorkspacePlan(this.planDeps(), input);

  getCitadelContext = (input: { cwd: string }) => workspacePlans.getCitadelContext(this.planDeps(), input);

  reportPlanDeviation = (input: {
    workspaceId?: string | undefined;
    checkoutId?: string | undefined;
    cwd?: string | undefined;
    planVersionId?: string | undefined;
    severity?: PlanDeviationReport["severity"] | undefined;
    description: string;
    reportedBySessionId?: string | undefined;
  }) => workspacePlans.reportPlanDeviation(this.planDeps(), input);

  startWorkspaceManager = (input: WorkspaceManagerControlInput) =>
    workspaceManager.startWorkspaceManager(this.managerDeps(), input);

  pauseWorkspaceManager = (input: WorkspaceManagerControlInput) =>
    workspaceManager.pauseWorkspaceManager(this.managerDeps(), input);

  resumeWorkspaceManager = (input: WorkspaceManagerControlInput) =>
    workspaceManager.resumeWorkspaceManager(this.managerDeps(), input);

  runWorkspaceManagerTick = (input: { workspaceId: string; leaseOwnerId?: string; leaseSeconds?: number }) =>
    workspaceManager.runWorkspaceManagerTick(this.managerDeps(), input);

  getCheckoutGateStatus = (input: CheckoutContextInput) =>
    workspaceManager.getCheckoutGateStatus(this.managerDeps(), input);

  markCheckoutReadyForReview = (input: MarkCheckoutReadyForReviewInput) =>
    workspaceManager.markCheckoutReadyForReview(this.managerDeps(), input);

  registerCheckoutReviewArtifact = (
    input: RegisterCheckoutReviewArtifactInput,
    options?: { actor?: workspaceManager.TrustedToolActor },
  ) => workspaceManager.registerCheckoutReviewArtifact(this.managerDeps(), input, options);

  updateTicketStatus = (input: UpdateTicketStatusInput) =>
    workspaceManager.updateTicketStatus(this.managerDeps(), input);

  runWorkspaceLayoutMigrations = () => {
    if (!hasWorkspaceLayoutMigrationCandidates(this.store)) {
      return { operationId: null, considered: 0, migrated: 0, skipped: [] };
    }
    const operation = this.operation(
      "workspace.layout_migration",
      "running",
      null,
      null,
      5,
      "Migrating legacy workspace layouts",
    );
    const summary = runWorkspaceLayoutMigrationsImpl({
      store: this.store,
      log: (level, message) => this.logOp(operation.id, level, message),
    });
    const failed = summary.skipped.filter((entry) => entry.reason === "migration_failed");
    this.finalizeOperation(operation.id, {
      status: failed.length ? "failed" : "succeeded",
      progress: 100,
      message: `Workspace layout migration: ${summary.migrated} migrated, ${summary.skipped.length} skipped`,
      error: failed.length ? `${failed.length} workspace layout migration(s) failed` : null,
    });
    if (summary.migrated > 0) {
      this.activity(
        "workspace.layout_migration.migrated",
        "system",
        `Migrated ${summary.migrated} workspace layout(s)`,
        null,
        null,
        operation.id,
      );
    }
    if (summary.skipped.length > 0) {
      this.activity(
        "workspace.layout_migration.skipped",
        "system",
        `Skipped ${summary.skipped.length} workspace layout migration(s)`,
        null,
        null,
        operation.id,
      );
    }
    return { operationId: operation.id, ...summary };
  };

  createAgentSession = (
    input: CreateAgentSessionOperationInput,
    runtime: RuntimeDescriptor,
    options: { activitySource?: ActivityEvent["source"] } = {},
  ) => {
    if (input.namespaceId) {
      const ws = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
      if (ws && input.namespaceId !== ws.namespaceId)
        this.assignWorkspaceToNamespace({ workspaceId: ws.id, namespaceId: input.namespaceId });
    }
    return createAgentSessionImpl(
      {
        store: this.store,
        terminal: this.config?.terminal,
        ...(this.config?.dataDir ? { dataDir: this.config.dataDir } : {}),
        baseSystemPrompt: this.config?.agentSessions?.baseSystemPrompt ?? "",
        activity: (...args) => this.activity(...args),
        runNotificationHooks: (event, repo, workspace, operationId, payload) =>
          this.runNotificationHooks(event, repo, workspace, operationId, payload),
        runAutoTransitions: this.runAutoTransitionsDep,
      },
      input,
      runtime,
      options,
    );
  };

  createTerminalSession = (
    input: CreateTerminalSessionInput,
    options: { activitySource?: ActivityEvent["source"] } = {},
  ) => {
    if (input.namespaceId) {
      const ws = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
      if (ws && input.namespaceId !== ws.namespaceId)
        this.assignWorkspaceToNamespace({ workspaceId: ws.id, namespaceId: input.namespaceId });
    }
    return createTerminalSessionImpl(
      {
        store: this.store,
        terminal: this.config?.terminal,
        activity: (...args) => this.activity(...args),
      },
      input,
      options,
    );
  };

  launchAgent = (input: LaunchAgentInput, runtime: RuntimeDescriptor) =>
    launchAgentImpl(
      {
        store: this.store,
        createWorkspace: (workspaceInput) => this.createWorkspace(workspaceInput),
        createAgentSession: (sessionInput, sessionRuntime) => this.createAgentSession(sessionInput, sessionRuntime),
        createWorkspaceCheckout: (checkoutInput) => this.createWorkspaceCheckout(checkoutInput),
        ...(this.config?.dataDir ? { dataDir: this.config.dataDir } : {}),
        activity: ({ type, source, message, repoId, workspaceId, operationId }) =>
          this.activity(type, source, message, repoId, workspaceId, operationId),
      },
      input,
      runtime,
    );

  readAgentTranscript = (i: { sessionId: string; lines?: number; maxChars?: number }) =>
    agentMessages.readAgentTranscript(this.store, i);
  sendAgentMessage = (i: Parameters<typeof agentMessages.sendAgentMessage>[1]) =>
    agentMessages.sendAgentMessage(this.store, i);
  readAgentHistory = (i: { sessionId: string; limit?: number; maxChars?: number }) =>
    agentHistory.readAgentHistory(this.store, i);
  getSessionPromptSummary = (sessionId: string) => agentHistory.getSessionPromptSummary(this.store, sessionId);

  stopAgentSession(input: { sessionId: string }) {
    const session = this.store.listWorkspaceSessions().find((candidate) => candidate.id === input.sessionId);
    if (!session) return { stopped: false, reason: "session_not_found" as const };
    if (session.kind !== "agent") return { stopped: false, reason: "session_not_agent" as const };
    return this.stopWorkspaceSession(input);
  }

  stopWorkspaceSession(input: { sessionId: string }) {
    const session = this.store.listWorkspaceSessions().find((candidate) => candidate.id === input.sessionId);
    if (!session) return { stopped: false, reason: "session_not_found" as const };
    if (session.tmuxSessionName) killTmuxSession(session.tmuxSessionName, session.tmuxSocketName ?? null);
    this.store.closeWorkspaceSession(session.id);
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    const activityType = session.kind === "agent" ? "agent.stopped" : "terminal.stopped";
    this.activity(
      activityType,
      "user",
      `Stopped ${session.displayName}`,
      workspace?.repoId ?? null,
      session.workspaceId,
      null,
    );
    return { stopped: true, removed: false, closed: true, reason: "ok" as const };
  }

  cancelOperation(operationId: string) {
    const result = cancelOperationInStore(this.store, operationId, nowIso);
    if (result.cancelled && result.operation)
      this.activity(
        "operation.cancelled",
        "user",
        `Cancelled ${result.operation.type}`,
        result.operation.repoId,
        result.operation.workspaceId,
        result.operation.id,
      );
    return { cancelled: result.cancelled, reason: result.reason };
  }

  async retryOperation(operationId: string) {
    const operation = this.store.findOperation(operationId);
    if (!operation) return { retried: false, reason: "not_found" as const };
    if (!operation.retriable || !operation.retryInput) return { retried: false, reason: "not_retriable" as const };
    const kind = operation.retryInput.kind;
    if (kind === "workspace.action") {
      const workspaceId = operation.retryInput.workspaceId as string;
      const action = operation.retryInput.action as HookAction;
      const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return { retried: false, reason: "workspace_missing" as const };
      const repo = this.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return { retried: false, reason: "repo_missing" as const };
      const result = await this.runWorkspaceAction({ repo, workspace, action });
      return { retried: true, operationId: result.operationId, status: result.status };
    }
    if (kind === "deploy.redeploy" || kind === "deploy.undeploy") {
      const workspaceId = operation.retryInput.workspaceId as string;
      const appName = (operation.retryInput.appName as string | null) ?? undefined;
      const checkoutId = (operation.retryInput.checkoutId as string | null) ?? undefined;
      const result =
        kind === "deploy.redeploy"
          ? await this.redeployApp({ workspaceId, checkoutId, appName })
          : await this.undeployApp({ workspaceId, checkoutId, appName });
      return { retried: true, operationId: result.operationId, status: result.status };
    }
    return { retried: false, reason: "unknown_kind" as const };
  }

  reconcile(): { sessions: number; workspaces: number; repos: number; deletedSessions: number } {
    return reconcileStore(this.store, (message, repoId) =>
      this.activity("repo.removed", "system", message, repoId, null, null),
    );
  }

  removeWorkspace = (input: { workspaceId: string; force?: boolean; archiveOnly?: boolean }) =>
    removeWorkspaceImpl(this.workspaceOpsDeps(), input);

  removeWorkspaceCheckout = (input: { workspaceId: string; checkoutId: string; force?: boolean }) =>
    removeWorkspaceCheckoutImpl(this.workspaceOpsDeps(), input);

  checkWorkspaceRemoval = (input: { workspaceId: string; archiveOnly?: boolean }) =>
    checkWorkspaceRemovalImpl(this.workspaceOpsDeps(), input);

  async removeRepo(input: { repoId: string; force?: boolean; cleanupWorktrees?: boolean }) {
    const repo = this.store.listRepos().find((candidate) => candidate.id === input.repoId);
    if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
    const workspaces = this.store.listWorkspaces(repo.id);
    const sessions = this.store
      .listWorkspaceSessions()
      .filter((session) => workspaces.some((workspace) => workspace.id === session.workspaceId));
    const activeSessions = sessions.filter((session) =>
      ["starting", "running", "waiting_for_input", "rate_limited", "usage_limited", "idle"].includes(session.status),
    );
    const runningOperations = this.store
      .listOperations()
      .filter((operation) => operation.repoId === repo.id && ["queued", "running"].includes(operation.status));
    const operation = this.operation(
      "repo.remove",
      "running",
      repo.id,
      null,
      10,
      input.cleanupWorktrees ? "Checking repository cleanup impact" : "Archiving repository metadata",
    );

    if (!input.force && (activeSessions.length || runningOperations.length)) {
      this.store.upsertOperation({
        ...operation,
        status: "failed",
        progress: 100,
        error: `Repository has ${activeSessions.length} active sessions and ${runningOperations.length} running operations. Confirm removal to continue.`,
        updatedAt: nowIso(),
      });
      this.activity(
        "repo.remove.blocked",
        "system",
        `Removal blocked for ${repo.name}; active sessions or operations exist`,
        repo.id,
        null,
        operation.id,
      );
      return {
        operationId: operation.id,
        removed: false,
        archivedWorkspaces: 0,
        cleanupWorktrees: Boolean(input.cleanupWorktrees),
        activeSessions: activeSessions.length,
        runningOperations: runningOperations.length,
      };
    }

    for (const session of sessions) {
      if (session.tmuxSessionName && input.cleanupWorktrees)
        killTmuxSession(session.tmuxSessionName, session.tmuxSocketName ?? null);
    }

    let cleanedWorktrees = 0;
    if (input.cleanupWorktrees) {
      for (const workspace of workspaces) {
        if (!fs.existsSync(workspace.path)) continue;
        try {
          tryRunGit(repo.rootPath, ["worktree", "remove", "--force", workspace.path]);
          cleanedWorktrees += 1;
        } catch (error) {
          if (!input.force) {
            const message = error instanceof Error ? error.message : "repo_cleanup_failed";
            this.store.upsertOperation({
              ...operation,
              status: "failed",
              progress: 100,
              error: message,
              updatedAt: nowIso(),
            });
            this.activity(
              "repo.remove.blocked",
              "system",
              `Cleanup failed while removing ${repo.name}: ${message}`,
              repo.id,
              null,
              operation.id,
            );
            return {
              operationId: operation.id,
              removed: false,
              archivedWorkspaces: 0,
              cleanupWorktrees: true,
              cleanedWorktrees,
              activeSessions: activeSessions.length,
              runningOperations: runningOperations.length,
            };
          }
        }
      }
    }

    this.store.archiveRepo(repo.id);
    this.store.upsertOperation({
      ...operation,
      status: "succeeded",
      progress: 100,
      message: input.cleanupWorktrees
        ? `Repository removed and ${cleanedWorktrees} worktrees cleaned up`
        : "Repository removed from Citadel tracking; worktrees preserved",
      updatedAt: nowIso(),
    });
    this.activity(
      "repo.removed",
      "user",
      input.cleanupWorktrees
        ? `Removed ${repo.name} and cleaned ${cleanedWorktrees} worktrees`
        : `Removed ${repo.name} from tracking and preserved worktrees`,
      repo.id,
      null,
      operation.id,
    );
    return {
      operationId: operation.id,
      removed: true,
      archivedWorkspaces: workspaces.length,
      cleanupWorktrees: Boolean(input.cleanupWorktrees),
      cleanedWorktrees,
      activeSessions: activeSessions.length,
      runningOperations: runningOperations.length,
    };
  }

  discoverWorkspaceApps(input: { repo: Repo; workspace: Workspace; providerContext?: unknown }) {
    return discoverWorkspaceAppsImpl(this.workspaceAppsDeps(), input);
  }

  runWorkspaceAction(input: { repo: Repo; workspace: Workspace; action: HookAction }) {
    return runWorkspaceActionImpl(this.workspaceAppsDeps(), input);
  }

  listDeployedApps = (input: { workspaceId: string; checkoutId?: string | null | undefined }) =>
    listDeployedAppsImpl(this.deployOpsDeps(), this.resolveRepoWorkspaceTarget(input));
  private deployActionInflight = new Map<string, ReturnType<typeof redeployAppImpl>>();
  redeployApp = (input: {
    workspaceId: string;
    checkoutId?: string | null | undefined;
    appName?: string | undefined;
  }) => this.runDeployAction(input, redeployAppImpl);
  undeployApp = (input: {
    workspaceId: string;
    checkoutId?: string | null | undefined;
    appName?: string | undefined;
  }) => this.runDeployAction(input, undeployAppImpl);

  private runDeployAction(
    input: { workspaceId: string; checkoutId?: string | null | undefined; appName?: string | undefined },
    action: typeof redeployAppImpl,
  ) {
    const key = deployActionInflightKey(input.workspaceId, input.checkoutId);
    const existing = this.deployActionInflight.get(key);
    if (existing) return existing;
    const target = this.resolveRepoWorkspaceTarget(input);
    const promise = action(this.deployOpsDeps(), {
      ...target,
      checkoutId: input.checkoutId ?? undefined,
      appName: input.appName,
    }).finally(() => {
      this.deployActionInflight.delete(key);
    });
    this.deployActionInflight.set(key, promise);
    return promise;
  }

  private resolveRepoWorkspaceTarget(input: {
    workspaceId: string;
    checkoutId?: string | null | undefined;
  }): { repo: Repo; workspace: Workspace } {
    if (!input.checkoutId) return this.resolveRepoWorkspace(input.workspaceId);
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const checkout = this.store.findWorkspaceCheckout(input.checkoutId);
    if (!checkout || checkout.workspaceId !== workspace.id || checkout.archivedAt) {
      throw new Error(`Unknown checkout: ${input.checkoutId}`);
    }
    const repo = this.store.listRepos().find((candidate) => candidate.id === checkout.repoId);
    if (!repo) throw new Error(`Checkout repo is missing: ${checkout.repoId}`);
    return { repo, workspace: workspaceForCheckout(workspace, checkout) };
  }

  private resolveRepoWorkspace(workspaceId: string): { repo: Repo; workspace: Workspace } {
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
    const repo = this.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) throw new Error(`Workspace repo is missing: ${workspace.repoId}`);
    return { repo, workspace };
  }

  private deployOpsDeps = (): DeployOpsDeps => ({
    store: this.store,
    activity: (...args) => this.activity(...args),
    newOperation: (...args) => this.operation(...args),
  });

  private workspaceAppsDeps = (): WorkspaceAppsDeps => ({
    store: this.store,
    config: this.config,
    activity: (...args) => this.activity(...args),
    newOperation: (...args) => this.operation(...args),
  });

  listNamespaces = (includeArchived = false): Namespace[] => this.store.listNamespaces(includeArchived);
  createNamespace = (input: CreateNamespaceInput) => namespaceOps.createNamespace(this.nsDeps(), input);
  renameNamespace = (id: string, patch: UpdateNamespaceInput) => namespaceOps.renameNamespace(this.nsDeps(), id, patch);
  archiveNamespace = (id: string) => namespaceOps.archiveNamespace(this.nsDeps(), id);
  restoreNamespace = (id: string) => namespaceOps.restoreNamespace(this.nsDeps(), id);
  reorderNamespaces = (input: { namespaceIds: string[] }) => namespaceOps.reorderNamespaces(this.nsDeps(), input);
  assignWorkspaceToNamespace = (input: { workspaceId: string; namespaceId: string | null }) =>
    namespaceOps.assignWorkspaceToNamespace(this.nsDeps(), input);
  private nsDeps = (): namespaceOps.NamespaceServiceDeps => ({
    store: this.store,
    activity: (type, message) => this.activity(type, "user", message, null, null, null),
  });

  hookDiagnostics = (repo: Repo, workspace?: Workspace | null) =>
    listHookDiagnostics({
      repo,
      workspace,
      hooks: this.config?.hooks ?? [],
      appHookIds: this.config?.repoDefaults.appHookIds ?? [],
      actionHookIds: this.config?.repoDefaults.actionHookIds ?? [],
      hookTimeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
    });

  async runHookEvent(input: {
    event: HookEvent;
    repo: Repo;
    workspace: Workspace;
    payload?: unknown;
    hookIds?: string[] | null;
    operationType?: string;
    operationMessage?: string;
  }): Promise<{ operationId: string; ran: number }> {
    const operation = this.operation(
      input.operationType ?? `hook.${input.event}`,
      "running",
      input.repo.id,
      input.workspace.id,
      10,
      input.operationMessage ?? `Running ${input.event} hooks`,
    );
    try {
      const result = await this.runWorkspaceHooks(
        input.event,
        input.hookIds ?? null,
        input.repo,
        input.workspace,
        operation.id,
        input.payload,
      );
      this.store.upsertOperation({
        ...operation,
        status: "succeeded",
        progress: 100,
        message: result.ran ? `Ran ${result.ran} ${input.event} hook(s)` : `No ${input.event} hooks found`,
        updatedAt: nowIso(),
      });
      return { operationId: operation.id, ran: result.ran };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `hook_${input.event}_failed`;
      this.logOp(operation.id, "error", `${input.event} hook failed: ${errorMessage}`);
      this.store.upsertOperation({
        ...operation,
        status: "failed",
        progress: 100,
        error: errorMessage,
        updatedAt: nowIso(),
      });
      throw error;
    }
  }

  private operation(
    type: string,
    status: Operation["status"],
    repoId: string | null,
    workspaceId: string | null,
    progress: number,
    message: string,
  ) {
    const now = nowIso();
    const operation: Operation = {
      id: createId("op"),
      type,
      status,
      repoId,
      workspaceId,
      progress,
      message,
      error: null,
      logs: [{ level: "info", message, at: now }],
      retriable: false,
      retryInput: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertOperation(operation);
    return operation;
  }

  private logOp(operationId: string, level: "info" | "warn" | "error", message: string) {
    this.store.appendOperationLog(operationId, { level, message, at: nowIso() });
  }

  // Reads the current row before upsert so streamed log lines (appended via
  // appendOperationLog) aren't clobbered by the INSERT-OR-REPLACE pattern.
  private finalizeOperation(operationId: string, patch: Partial<Operation>) {
    const current = this.store.findOperation(operationId);
    if (current) this.store.upsertOperation({ ...current, ...patch, updatedAt: nowIso() });
  }

  private activity(
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
    hookOutput?: HookOutput | null,
  ) {
    this.store.addActivity({
      id: createId("evt"),
      type,
      source,
      repoId,
      workspaceId,
      operationId,
      message,
      hookOutput: hookOutput ?? null,
      createdAt: nowIso(),
    });
  }

  private hooksDeps() {
    return {
      config: this.config,
      activity: (...args: Parameters<typeof this.activity>) => this.activity(...args),
      dispatchAgentHook: this.dispatchAgentHook,
    };
  }

  private runWorkspaceHooks = (
    event: HookEvent,
    hookIds: string[] | null,
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload?: unknown,
  ) => runWorkspaceHooks({ ...this.hooksDeps(), event, hookIds, repo, workspace, operationId, payload });

  private runNotificationHooks = (
    event: HookEvent,
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: unknown,
  ) => runNotificationHooks({ ...this.hooksDeps(), event, repo, workspace, operationId, payload });

  private dispatchAgentHook: DispatchAgentHook = (input) =>
    dispatchAgentHookImpl(buildDispatchAgentHookDeps(this.config, this.createAgentSession), input);

  // Binds the class's private helpers as deps for the extracted
  // create-workspace / remove-workspace modules. Built once per call so
  // arrow-bound `this` stays stable across reentrant flows.
  private workspaceOpsDeps(): WorkspaceOpsDeps {
    return {
      store: this.store,
      config: this.config,
      operation: (...args) => this.operation(...args),
      logOp: (...args) => this.logOp(...args),
      activity: (...args) => this.activity(...args),
      runWorkspaceHooks: (...args) => this.runWorkspaceHooks(...args),
      runNotificationHooks: (...args) => this.runNotificationHooks(...args),
      runAutoTransitions: this.runAutoTransitionsDep,
    };
  }

  private planDeps(): workspacePlans.WorkspacePlanDeps {
    return {
      store: this.store,
      activity: (...args) => this.activity(...args),
    };
  }

  private managerDeps(): workspaceManager.WorkspaceManagerDeps {
    return {
      store: this.store,
      activity: (...args) => this.activity(...args),
    };
  }
}

// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { runDoctorChecks } from "./doctor.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export type { DeployHookStatus, DoctorConfig, DoctorDeps, DoctorProviderProbe, DoctorProviderStatus, DoctorRepo } from "./doctor.js";
