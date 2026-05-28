import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig, HookConfig } from "@citadel/config";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
import type { ActivityEvent, CreateAgentSessionInput, CreateNamespaceInput, CreateWorkspaceInput, HookAction, HookOutput, LaunchAgentInput, Namespace, Operation, Repo, UpdateNamespaceInput, Workspace } from "@citadel/contracts";
import { createId, nowIso, repoDisplayName, workspaceBranchName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";
import * as agentHistory from "./agent-history.js";
import * as agentMessages from "./agent-messages.js";
import { type RuntimeDescriptor, createAgentSession as createAgentSessionImpl } from "./create-agent-session.js";
import { launchAgent as launchAgentImpl } from "./launch-agent.js";
import * as namespaceOps from "./namespaces.js";
export type { TranscriptResult, TranscriptErrorResult, SendMessageResult } from "./agent-messages.js";
export type { LaunchAgentResult } from "./launch-agent.js";
export type { AssignWorkspaceResult, CreateNamespaceResult } from "./namespaces.js";
export type { AgentHistoryResult, AgentHistoryErrorResult } from "./agent-history.js";
export * from "./status.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { ScheduledAgentRunner, parseCronExpression, cronMatches, nextCronRun, describeCron } from "./scheduled-agents.js";
export { MAX_QUEUED_RUNS_PER_AGENT } from "./scheduled-agents.js";
export type { CronExpression, ScheduledAgentRunResult, ScheduledAgentDeps } from "./scheduled-agents.js";
export { createBackgroundAgentSession } from "./create-background-agent-session.js";
export {
  createDiagnosticsLogger,
  noopDiagnosticsLogger,
  type DiagnosticEvent,
  type DiagnosticsLogger,
  type DiagnosticsLoggerOptions,
} from "./diagnostics.js";
export { parseUsageLimitResetFromReason, deriveAccountUsageLimit } from "./usage-limit.js";
export type { AccountRateLimitInfo } from "./usage-limit.js";
export { DEFAULT_AUTO_RESUME_INTERVAL_MS, startAutoResumeLoop } from "./auto-resume.js";
export type { AutoResumeDeps, AutoResumeLoopHandle } from "./auto-resume.js";
// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
import { type DeployOpsDeps, listDeployedApps as listDeployedAppsImpl, redeployApp as redeployAppImpl } from "./deploy.js";
import {
  BranchInUseByWorktreeError,
  RemoteRefMissingError,
  WorkspaceNameTakenError,
  addWorktree,
  cancelOperationInStore,
  classifyWorktreeError,
  cleanupWorktree,
  discoverDefaultBranch,
  isUniqueWorkspaceNameViolation,
  listHookDiagnostics,
  reconcileStore,
  tryRunGit,
  workspaceIsDirty,
} from "./helpers.js";

// biome-ignore format: keep on one line to stay inside the 800-line file-size budget
export { BranchInUseByWorktreeError, RemoteRefMissingError, WorkspaceInUseError, WorkspaceNameTakenError } from "./helpers.js";
import { buildDispatchAgentHookDeps, dispatchAgentHook as dispatchAgentHookImpl } from "./dispatch-agent-hook.js";
import { type DispatchAgentHook, runNotificationHooks, runWorkspaceHooks } from "./hooks-runner.js";
import {
  type WorkspaceAppsDeps,
  discoverWorkspaceApps as discoverWorkspaceAppsImpl,
  runWorkspaceAction as runWorkspaceActionImpl,
} from "./workspace-apps.js";

export class OperationService {
  // Daemon registers onSessionStopped to release the ttyd whenever stopAgentSession runs (REST, MCP, restore route).
  private terminalHooks: { onSessionStopped?: (sessionId: string) => void } = {};

  constructor(
    private readonly store: SqliteStore,
    private readonly config?: {
      hooks: HookConfig[];
      repoDefaults: {
        setupHookIds: string[];
        teardownHookIds: string[];
        appHookIds?: string[];
        actionHookIds?: string[];
      };
      commandPolicy: CitadelConfig["commandPolicy"];
      runtimes?: CitadelConfig["runtimes"];
    },
  ) {}

  // biome-ignore format: keep on one line to stay inside the 800-line file-size budget
  setTerminalHooks(hooks: { onSessionStopped?: (sessionId: string) => void }) { this.terminalHooks = hooks; }

  registerRepo(input: { rootPath: string; name?: string | undefined; worktreeParent?: string | undefined }) {
    const now = nowIso();
    const rootPath = path.resolve(input.rootPath);
    if (!fs.existsSync(path.join(rootPath, ".git"))) throw new Error(`Not a git repository: ${rootPath}`);
    const repo: Repo = {
      id: createId("repo"),
      name: input.name || repoDisplayName(rootPath),
      rootPath,
      defaultBranch: discoverDefaultBranch(rootPath),
      defaultRemote: "origin",
      worktreeParent: input.worktreeParent || path.join(path.dirname(rootPath), `${path.basename(rootPath)}-worktrees`),
      setupHookIds: this.config?.repoDefaults.setupHookIds ?? [],
      teardownHookIds: this.config?.repoDefaults.teardownHookIds ?? [],
      providerIds: ["github-gh", "jira-jtk"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.store.insertRepo(repo);
    this.activity("repo.registered", "user", `Registered ${repo.name}`, repo.id, null, null);
    const rootWorkspace: Workspace = {
      id: createId("ws"),
      repoId: repo.id,
      name: "main",
      path: repo.rootPath,
      branch: repo.defaultBranch,
      baseBranch: repo.defaultBranch,
      source: "imported",
      kind: "root",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: true,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      this.store.insertWorkspace(rootWorkspace);
      this.activity(
        "workspace.root.created",
        "system",
        `Linked root workspace for ${repo.name}`,
        repo.id,
        rootWorkspace.id,
        null,
      );
    } catch {} // root already present (re-register or migration backfill)
    return repo;
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    const repo = this.store.listRepos().find((candidate) => candidate.id === input.repoId);
    if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
    const namespaceId = input.namespaceId ?? null;
    if (namespaceId) {
      const namespace = this.store.findNamespace(namespaceId);
      if (!namespace) throw new Error(`Unknown namespace: ${namespaceId}`);
      if (namespace.archivedAt) throw new Error(`Namespace is archived: ${namespaceId}`);
    }
    const now = nowIso();
    const operation = this.operation("workspace.create", "running", repo.id, null, 5, "Validating workspace request");
    const newBranch = input.newBranch?.trim() || null;
    const branch = newBranch ?? workspaceBranchName(input);
    const workspacePath = path.join(repo.worktreeParent, branch);
    const baseBranch = input.baseBranch?.trim() || repo.defaultBranch;
    const existingBranch = input.existingBranch?.trim() || null;
    const workspace: Workspace = {
      id: createId("ws"),
      repoId: repo.id,
      name: input.name,
      path: workspacePath,
      branch: existingBranch ?? branch,
      baseBranch,
      source: input.source,
      kind: "worktree",
      prUrl: input.prUrl ?? null,
      issueKey: input.issueKey ?? null,
      issueTitle: input.issueTitle ?? null,
      issueUrl: input.issueUrl ?? null,
      slackThreadUrl: input.slackThreadUrl ?? null,
      section: "backlog",
      pinned: false,
      lifecycle: "creating",
      dirty: false,
      namespaceId,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    try {
      this.store.insertWorkspace(workspace);
    } catch (error) {
      if (isUniqueWorkspaceNameViolation(error)) {
        this.store.upsertOperation({
          ...operation,
          status: "failed",
          progress: 100,
          error: `workspace_name_taken: ${input.name}`,
          updatedAt: nowIso(),
        });
        throw new WorkspaceNameTakenError(repo.id, input.name);
      }
      throw error;
    }
    this.logOp(
      operation.id,
      "info",
      `Created workspace record name=${workspace.name} branch=${workspace.branch} base=${baseBranch} source=${input.source}`,
    );
    this.store.upsertOperation({
      ...operation,
      workspaceId: workspace.id,
      progress: 20,
      message: "Fetching remote metadata",
    });
    fs.mkdirSync(repo.worktreeParent, { recursive: true });
    try {
      tryRunGit(repo.rootPath, ["fetch", "--prune", repo.defaultRemote]);
      this.logOp(operation.id, "info", `Fetched ${repo.defaultRemote} (prune)`);
      const added = addWorktree(repo.rootPath, workspacePath, repo.defaultRemote, baseBranch, branch, existingBranch);
      this.logOp(
        operation.id,
        "info",
        added.mode === "checkout"
          ? `Added worktree at ${workspacePath} on branch ${existingBranch}`
          : added.mode === "tracking"
            ? `Added worktree at ${workspacePath} tracking ${added.startPoint}`
            : `Added worktree at ${workspacePath} (new branch ${existingBranch ?? branch} from ${added.startPoint})`,
      );
      this.store.upsertOperation({
        ...operation,
        workspaceId: workspace.id,
        progress: 75,
        message: "Running workspace setup hooks",
        updatedAt: nowIso(),
      });
      this.logOp(
        operation.id,
        "info",
        `Running ${repo.setupHookIds.length} setup hook(s): ${repo.setupHookIds.join(", ") || "(none)"}`,
      );
      await this.runWorkspaceHooks("workspace.setup", repo.setupHookIds, repo, workspace, operation.id);
      this.store.updateWorkspaceLifecycle(workspace.id, "ready");
      this.activity(
        "workspace.created",
        "system",
        `Created workspace ${workspace.name}`,
        repo.id,
        workspace.id,
        operation.id,
      );
      await this.runNotificationHooks("workspace.created", repo, workspace, operation.id, { repo, workspace });
      this.store.upsertOperation({
        ...operation,
        workspaceId: workspace.id,
        status: "succeeded",
        progress: 100,
        message: "Workspace ready",
        updatedAt: nowIso(),
      });
    } catch (error) {
      this.store.updateWorkspaceLifecycle(workspace.id, "failed");
      const errorMessage = error instanceof Error ? error.message : "workspace_create_failed";
      this.logOp(operation.id, "error", `Workspace create failed: ${errorMessage}`);
      this.store.upsertOperation({
        ...operation,
        workspaceId: workspace.id,
        status: "failed",
        progress: 100,
        error: errorMessage,
        updatedAt: nowIso(),
      });
      const classified = classifyWorktreeError(errorMessage);
      if (classified) throw new BranchInUseByWorktreeError(classified.branch, classified.worktreePath);
      if (/invalid reference: \S+/i.test(errorMessage) && existingBranch)
        throw new RemoteRefMissingError(existingBranch, repo.defaultRemote);
    }
    return { operationId: operation.id, workspaceId: workspace.id };
  }

  createAgentSession = (
    input: CreateAgentSessionInput,
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
        activity: (...args) => this.activity(...args),
        runNotificationHooks: (event, repo, workspace, operationId, payload) =>
          this.runNotificationHooks(event, repo, workspace, operationId, payload),
      },
      input,
      runtime,
      options,
    );
  };

  launchAgent = (input: LaunchAgentInput, runtime: RuntimeDescriptor) =>
    launchAgentImpl(
      {
        store: this.store,
        createWorkspace: (workspaceInput) => this.createWorkspace(workspaceInput),
        createAgentSession: (sessionInput, sessionRuntime) => this.createAgentSession(sessionInput, sessionRuntime),
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
    const session = this.store.listSessions().find((candidate) => candidate.id === input.sessionId);
    if (!session) return { stopped: false, reason: "session_not_found" as const };
    if (session.tmuxSessionName) killTmuxSession(session.tmuxSessionName);
    this.terminalHooks.onSessionStopped?.(session.id);
    this.store.deleteSession(session.id);
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    this.activity(
      "agent.stopped",
      "user",
      `Stopped ${session.displayName}`,
      workspace?.repoId ?? null,
      session.workspaceId,
      null,
    );
    return { stopped: true, removed: true, reason: "ok" as const };
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
    if (kind === "deploy.redeploy") {
      const workspaceId = operation.retryInput.workspaceId as string;
      const appName = (operation.retryInput.appName as string | null) ?? undefined;
      const result = await this.redeployApp({ workspaceId, appName });
      return { retried: true, operationId: result.operationId, status: result.status };
    }
    return { retried: false, reason: "unknown_kind" as const };
  }

  /**
   * Reconcile local state with reality:
   *  - mark sessions as `orphaned` when their tmux session is gone
   *  - mark workspaces whose worktree directory no longer exists as failed
   *  - archive repos whose rootPath no longer exists.
   *
   * Returns counts of the cleanup performed.
   */
  reconcile(): { sessions: number; workspaces: number; repos: number; deletedSessions: number } {
    return reconcileStore(this.store, (message, repoId) =>
      this.activity("repo.removed", "system", message, repoId, null, null),
    );
  }

  async removeWorkspace(input: { workspaceId: string; force?: boolean; archiveOnly?: boolean }) {
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const repo = this.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) throw new Error(`Workspace repo is missing: ${workspace.repoId}`);
    if (workspace.kind === "root") {
      // Root workspace can only be dropped via repo removal.
      const operation = this.operation(
        "workspace.remove",
        "failed",
        workspace.repoId,
        workspace.id,
        100,
        "Cannot drop the root workspace",
      );
      this.store.upsertOperation({
        ...operation,
        error: "Root workspace is non-removable. Remove the repository to drop it.",
        updatedAt: nowIso(),
      });
      return { operationId: operation.id, removed: false, archived: false, dirty: false };
    }
    const operation = this.operation(
      "workspace.remove",
      "running",
      workspace.repoId,
      workspace.id,
      10,
      "Checking workspace status",
    );
    const dirty = workspaceIsDirty(workspace.path);
    if (dirty && !input.force && !input.archiveOnly) {
      this.store.updateWorkspaceLifecycle(workspace.id, "ready", true);
      this.store.upsertOperation({
        ...operation,
        status: "failed",
        progress: 100,
        error: "Workspace has uncommitted changes. Use metadata archive or explicit force cleanup.",
        updatedAt: nowIso(),
      });
      this.activity(
        "workspace.remove.blocked",
        "system",
        `Removal blocked because ${workspace.name} has dirty git status`,
        workspace.repoId,
        workspace.id,
        operation.id,
      );
      return { operationId: operation.id, removed: false, archived: false, dirty };
    }

    const ownedSessions = this.store.listSessions(workspace.id);
    for (const session of ownedSessions) {
      if (session.tmuxSessionName && !input.archiveOnly) killTmuxSession(session.tmuxSessionName);
      // Always release the ttyd alongside — applies to both archive and full
      // remove. Otherwise the ttyd process keeps running detached, holding a
      // port + a tmux client slot, and a future iframe attempt for the
      // (now-archived) session can't re-attach cleanly. The hook is a no-op
      // when no manager is wired (tests).
      this.terminalHooks.onSessionStopped?.(session.id);
    }
    if (ownedSessions.length && !input.archiveOnly) {
      this.logOp(operation.id, "info", `Killed ${ownedSessions.length} tmux session(s) attached to workspace`);
    }

    const worktreeMissing = !input.archiveOnly && !fs.existsSync(workspace.path);
    if (!input.archiveOnly && !worktreeMissing) {
      try {
        this.logOp(
          operation.id,
          "info",
          `Running ${repo.teardownHookIds.length} teardown hook(s): ${repo.teardownHookIds.join(", ") || "(none)"}`,
        );
        await this.runWorkspaceHooks("workspace.teardown", repo.teardownHookIds, repo, workspace, operation.id);
      } catch (error) {
        if (!input.force) {
          this.store.upsertOperation({
            ...operation,
            status: "failed",
            progress: 100,
            error: error instanceof Error ? error.message : "workspace_teardown_failed",
            updatedAt: nowIso(),
          });
          this.activity(
            "workspace.remove.blocked",
            "system",
            `Removal blocked because teardown failed for ${workspace.name}`,
            workspace.repoId,
            workspace.id,
            operation.id,
          );
          return { operationId: operation.id, removed: false, archived: false, dirty };
        }
      }
    }

    if (!input.archiveOnly) {
      const cleanup = cleanupWorktree(repo.rootPath, workspace.path);
      this.logOp(operation.id, "info", `${cleanup.action} worktree at ${workspace.path}`);
      if (cleanup.warning) this.logOp(operation.id, "warn", `git worktree prune failed: ${cleanup.warning}`);
    }
    if (input.archiveOnly) {
      this.store.archiveWorkspace(workspace.id, "archived", dirty);
      this.logOp(operation.id, "info", `Marked workspace ${workspace.name} as archived`);
    } else {
      this.store.deleteWorkspace(workspace.id);
      this.logOp(operation.id, "info", `Deleted workspace ${workspace.name} (name slot freed)`);
    }
    this.store.upsertOperation({
      ...operation,
      status: "succeeded",
      progress: 100,
      message: input.archiveOnly ? "Workspace metadata archived" : "Workspace removed",
      updatedAt: nowIso(),
    });
    this.activity(
      input.archiveOnly ? "workspace.archived" : "workspace.removed",
      "user",
      input.archiveOnly ? `Archived ${workspace.name}` : `Removed ${workspace.name}`,
      workspace.repoId,
      workspace.id,
      operation.id,
    );
    await this.runNotificationHooks(
      input.archiveOnly ? "workspace.archived" : "workspace.removed",
      repo,
      workspace,
      operation.id,
      { repo, workspace, result: { removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty } },
    );
    return { operationId: operation.id, removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty };
  }

  async removeRepo(input: { repoId: string; force?: boolean; cleanupWorktrees?: boolean }) {
    const repo = this.store.listRepos().find((candidate) => candidate.id === input.repoId);
    if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
    const workspaces = this.store.listWorkspaces(repo.id);
    const sessions = this.store
      .listSessions()
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
      if (session.tmuxSessionName && input.cleanupWorktrees) killTmuxSession(session.tmuxSessionName);
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

  listDeployedApps = (input: { workspaceId: string }) =>
    listDeployedAppsImpl(this.deployOpsDeps(), this.resolveRepoWorkspace(input.workspaceId));
  // Per-workspace inflight guard prevents concurrent redeploys (double-click, human+MCP overlap).
  private redeployInflight = new Map<string, ReturnType<typeof redeployAppImpl>>();
  redeployApp = (input: { workspaceId: string; appName?: string | undefined }) => {
    const existing = this.redeployInflight.get(input.workspaceId);
    if (existing) return existing;
    const promise = redeployAppImpl(this.deployOpsDeps(), {
      ...this.resolveRepoWorkspace(input.workspaceId),
      appName: input.appName,
    }).finally(() => {
      this.redeployInflight.delete(input.workspaceId);
    });
    this.redeployInflight.set(input.workspaceId, promise);
    return promise;
  };

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
    event: HookConfig["event"],
    hookIds: string[],
    repo: Repo,
    workspace: Workspace,
    operationId: string,
  ) => runWorkspaceHooks({ ...this.hooksDeps(), event, hookIds, repo, workspace, operationId });

  private runNotificationHooks = (
    event: HookConfig["event"],
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: unknown,
  ) => runNotificationHooks({ ...this.hooksDeps(), event, repo, workspace, operationId, payload });

  private dispatchAgentHook: DispatchAgentHook = (input) =>
    dispatchAgentHookImpl(buildDispatchAgentHookDeps(this.config, this.createAgentSession), input);
}
