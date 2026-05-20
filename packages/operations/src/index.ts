import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig, HookConfig } from "@citadel/config";
import type {
  AgentSession,
  CreateAgentSessionInput,
  CreateWorkspaceInput,
  HookAction,
  HookDiagnostic,
  HookOutput,
  Operation,
  Repo,
  Workspace,
  WorkspaceAppsSummary,
} from "@citadel/contracts";
import { createId, nowIso, repoDisplayName, workspaceBranchName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { hookDiagnostic, parseHookOutput, runCommandHook, runCommandHookForDiagnostics } from "@citadel/hooks";
import { ensureTmuxSession, killTmuxSession, sendKeys } from "@citadel/terminal";
import {
  asObject,
  cancelOperationInStore,
  discoverDefaultBranch,
  listHookDiagnostics,
  reconcileStore,
  tryRunGit,
  withActionHookIds,
  workspaceIsDirty,
} from "./helpers.js";

export class OperationService {
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
    },
  ) {}

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
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.store.insertRepo(repo);
    this.activity("repo.registered", "user", `Registered ${repo.name}`, repo.id, null, null);
    return repo;
  }

  async createWorkspace(input: CreateWorkspaceInput) {
    const repo = this.store.listRepos().find((candidate) => candidate.id === input.repoId);
    if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
    const now = nowIso();
    const operation = this.operation("workspace.create", "running", repo.id, null, 5, "Validating workspace request");
    const branch = workspaceBranchName(input);
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
      prUrl: input.prUrl ?? null,
      issueKey: input.issueKey ?? null,
      issueTitle: input.issueTitle ?? null,
      section: "backlog",
      pinned: false,
      lifecycle: "creating",
      dirty: false,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.store.insertWorkspace(workspace);
    this.store.upsertOperation({
      ...operation,
      workspaceId: workspace.id,
      progress: 20,
      message: "Fetching remote metadata",
    });
    fs.mkdirSync(repo.worktreeParent, { recursive: true });
    try {
      tryRunGit(repo.rootPath, ["fetch", "--prune", repo.defaultRemote]);
      if (existingBranch) {
        // Try to add a worktree pointing at the existing branch (local or remote).
        try {
          tryRunGit(repo.rootPath, ["worktree", "add", workspacePath, existingBranch]);
        } catch {
          tryRunGit(repo.rootPath, [
            "worktree",
            "add",
            "-B",
            existingBranch,
            workspacePath,
            `${repo.defaultRemote}/${existingBranch}`,
          ]);
        }
      } else {
        const startPoint = `${repo.defaultRemote}/${baseBranch}`;
        tryRunGit(repo.rootPath, ["worktree", "add", "-b", branch, workspacePath, startPoint]);
      }
      this.store.upsertOperation({
        ...operation,
        workspaceId: workspace.id,
        progress: 75,
        message: "Running workspace setup hooks",
        updatedAt: nowIso(),
      });
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
      this.store.upsertOperation({
        ...operation,
        workspaceId: workspace.id,
        status: "failed",
        progress: 100,
        error: error instanceof Error ? error.message : "workspace_create_failed",
        updatedAt: nowIso(),
      });
    }
    return { operationId: operation.id, workspaceId: workspace.id };
  }

  async createAgentSession(
    input: CreateAgentSessionInput,
    runtime: { command: string; args: string[]; displayName: string; promptArg?: string | null },
  ) {
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const now = nowIso();
    const sessionName = `citadel_${workspace.id}_${createId("agent").slice(-8)}`;
    // Build runtime args. If runtime declares a promptArg flag, embed prompt as a CLI flag.
    const runtimeArgs = [...runtime.args];
    let promptForKeys: string | null = null;
    if (input.prompt?.length) {
      if (runtime.promptArg) {
        runtimeArgs.push(runtime.promptArg, input.prompt);
      } else {
        promptForKeys = input.prompt;
      }
    }
    const tmux = await ensureTmuxSession({
      sessionName,
      cwd: workspace.path,
      command: runtime.command,
      args: runtimeArgs,
    });
    // For runtimes that do not support inline prompt args, type the prompt into the
    // tmux session after the runtime is up.
    if (promptForKeys) {
      try {
        sendKeys(sessionName, promptForKeys);
        sendKeys(sessionName, "\r");
      } catch {
        // best-effort: prompt injection failures are surfaced via activity below
      }
    }
    const session: AgentSession = {
      id: createId("sess"),
      workspaceId: workspace.id,
      runtimeId: input.runtimeId,
      displayName: input.displayName || runtime.displayName,
      status: "running",
      transport: "disconnected",
      tmuxSessionName: tmux.tmuxSessionName,
      tmuxSessionId: tmux.tmuxSessionId,
      createdAt: now,
      updatedAt: now,
    };
    this.store.insertSession(session);
    this.activity("agent.started", "user", `Started ${session.displayName}`, workspace.repoId, workspace.id, null);
    const repo = this.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (repo) await this.runNotificationHooks("agent.started", repo, workspace, null, { repo, workspace, session });
    return session;
  }

  stopAgentSession(input: { sessionId: string }) {
    const session = this.store.listSessions().find((candidate) => candidate.id === input.sessionId);
    if (!session) return { stopped: false, reason: "session_not_found" as const };
    if (session.tmuxSessionName) killTmuxSession(session.tmuxSessionName);
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

    for (const session of this.store.listSessions(workspace.id)) {
      if (session.tmuxSessionName && !input.archiveOnly) killTmuxSession(session.tmuxSessionName);
    }

    if (!input.archiveOnly) {
      try {
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

    if (!input.archiveOnly && fs.existsSync(workspace.path)) {
      tryRunGit(repo.rootPath, ["worktree", "remove", "--force", workspace.path]);
    }
    this.store.archiveWorkspace(workspace.id, input.archiveOnly ? "archived" : "removed", dirty);
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
      ["starting", "running", "waiting", "idle"].includes(session.status),
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

  async discoverWorkspaceApps(input: { repo: Repo; workspace: Workspace; providerContext?: unknown }) {
    const checkedAt = nowIso();
    const hookIds = this.config?.repoDefaults.appHookIds ?? [];
    const hooks = this.configuredHooks("workspace.apps", hookIds);
    const diagnostics: HookDiagnostic[] = [];
    const outputs: HookOutput[] = [];

    for (const hook of hooks) {
      const commandHook = {
        id: hook.id,
        event: hook.event,
        command: hook.command,
        args: hook.args,
        cwd: hook.cwd || input.workspace.path,
        timeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
        blocking: hook.blocking,
      };
      try {
        const result = await runCommandHookForDiagnostics(commandHook, {
          event: "workspace.apps",
          repo: input.repo,
          workspace: input.workspace,
          providerContext: input.providerContext ?? {},
          environment: process.env.NODE_ENV ?? "development",
        });
        const diagnostic = hookDiagnostic({ hook: commandHook, enabled: true, result, lastRunAt: checkedAt });
        diagnostics.push(diagnostic);
        if (diagnostic.structuredPayload) {
          outputs.push(withActionHookIds(diagnostic.structuredPayload, hook.id));
          this.activity(
            "hook.workspace.apps",
            "hook",
            `Hook ${hook.id} discovered workspace apps/actions`,
            input.repo.id,
            input.workspace.id,
            null,
            diagnostic.structuredPayload,
          );
        } else if (diagnostic.validationErrors.length) {
          this.activity(
            "hook.workspace.apps.invalid",
            "hook",
            `Hook ${hook.id} returned invalid app/action output`,
            input.repo.id,
            input.workspace.id,
            null,
          );
        }
      } catch (error) {
        diagnostics.push(hookDiagnostic({ hook: commandHook, enabled: true, error, lastRunAt: checkedAt }));
        this.activity(
          "hook.workspace.apps.failed",
          "hook",
          `Hook ${hook.id} failed: ${error instanceof Error ? error.message : "hook_failed"}`,
          input.repo.id,
          input.workspace.id,
          null,
        );
      }
    }

    return {
      workspaceId: input.workspace.id,
      status: diagnostics.some((diagnostic) => diagnostic.validationStatus === "invalid") ? "degraded" : "healthy",
      reason: diagnostics.length ? null : "No workspace application discovery hooks configured",
      hooks: diagnostics,
      applications: outputs.flatMap((output) => output.applications ?? []),
      links: outputs.flatMap((output) => output.links),
      actions: outputs.flatMap((output) => output.actions),
      checkedAt,
    } satisfies WorkspaceAppsSummary;
  }

  async runWorkspaceAction(input: { repo: Repo; workspace: Workspace; action: HookAction }) {
    const operation = this.operation(
      `workspace.action.${input.action.kind ?? "custom"}`,
      "running",
      input.repo.id,
      input.workspace.id,
      10,
      `Running ${input.action.label}`,
    );
    const hookIds = input.action.hookId ? [input.action.hookId] : (this.config?.repoDefaults.actionHookIds ?? []);
    const hooks = this.configuredHooks("workspace.action", hookIds);
    if (!hooks.length) {
      this.store.upsertOperation({
        ...operation,
        status: "failed",
        progress: 100,
        error: "No workspace action hooks are configured",
        updatedAt: nowIso(),
      });
      return { operationId: operation.id, status: "failed" as const };
    }
    try {
      for (const hook of hooks) {
        const result = await runCommandHook(
          {
            id: hook.id,
            event: hook.event,
            command: hook.command,
            args: hook.args,
            cwd: hook.cwd || input.workspace.path,
            timeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
            blocking: hook.blocking,
          },
          {
            event: "workspace.action",
            repo: input.repo,
            workspace: input.workspace,
            action: input.action,
            operationId: operation.id,
          },
        );
        this.activity(
          "hook.workspace.action",
          "hook",
          `${input.action.label} completed via hook ${hook.id}${result.stderr ? " with stderr" : ""}`,
          input.repo.id,
          input.workspace.id,
          operation.id,
          parseHookOutput(result.stdout),
        );
      }
      this.store.upsertOperation({
        ...operation,
        status: "succeeded",
        progress: 100,
        message: `${input.action.label} completed`,
        updatedAt: nowIso(),
      });
      return { operationId: operation.id, status: "succeeded" as const };
    } catch (error) {
      const message = error instanceof Error ? error.message : "workspace_action_failed";
      this.store.upsertOperation({
        ...operation,
        status: "failed",
        progress: 100,
        error: message,
        retriable: true,
        retryInput: { kind: "workspace.action", workspaceId: input.workspace.id, action: input.action },
        updatedAt: nowIso(),
      });
      this.activity(
        "hook.workspace.action.failed",
        "hook",
        `${input.action.label} failed: ${message}`,
        input.repo.id,
        input.workspace.id,
        operation.id,
      );
      return { operationId: operation.id, status: "failed" as const };
    }
  }

  hookDiagnostics(repo: Repo, workspace?: Workspace | null) {
    return listHookDiagnostics({
      repo,
      workspace,
      hooks: this.config?.hooks ?? [],
      appHookIds: this.config?.repoDefaults.appHookIds ?? [],
      actionHookIds: this.config?.repoDefaults.actionHookIds ?? [],
      hookTimeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
    });
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
      logs: [],
      retriable: false,
      retryInput: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.upsertOperation(operation);
    return operation;
  }

  private activity(
    type: string,
    source: "user" | "system" | "hook",
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

  private async runWorkspaceHooks(
    event: HookConfig["event"],
    hookIds: string[],
    repo: Repo,
    workspace: Workspace,
    operationId: string,
  ) {
    const hooks = (this.config?.hooks ?? []).filter((hook) => hook.event === event && hookIds.includes(hook.id));
    for (const hook of hooks) {
      const result = await runCommandHook(
        {
          id: hook.id,
          event,
          command: hook.command,
          args: hook.args,
          cwd: hook.cwd || workspace.path,
          timeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
          blocking: hook.blocking,
        },
        { event, repo, workspace, operationId },
      );
      const hookOutput = parseHookOutput(result.stdout);
      this.activity(
        `hook.${event}`,
        "hook",
        `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
        repo.id,
        workspace.id,
        operationId,
        hookOutput,
      );
    }
  }

  private async runNotificationHooks(
    event: HookConfig["event"],
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: unknown,
  ) {
    const hooks = (this.config?.hooks ?? []).filter((hook) => hook.event === event);
    for (const hook of hooks) {
      try {
        const result = await runCommandHook(
          {
            id: hook.id,
            event,
            command: hook.command,
            args: hook.args,
            cwd: hook.cwd || workspace.path,
            timeoutMs: this.config?.commandPolicy.hookTimeoutMs ?? 120000,
            blocking: hook.blocking,
          },
          { event, ...asObject(payload), operationId },
        );
        const hookOutput = parseHookOutput(result.stdout);
        this.activity(
          `hook.${event}`,
          "hook",
          `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
          repo.id,
          workspace.id,
          operationId,
          hookOutput,
        );
      } catch (error) {
        this.activity(
          `hook.${event}.failed`,
          "hook",
          `Hook ${hook.id} failed: ${error instanceof Error ? error.message : "hook_failed"}`,
          repo.id,
          workspace.id,
          operationId,
        );
      }
    }
  }

  private configuredHooks(event: HookConfig["event"], hookIds: string[]) {
    const hooks = (this.config?.hooks ?? []).filter((hook) => hook.event === event);
    return hookIds.length ? hooks.filter((hook) => hookIds.includes(hook.id)) : hooks;
  }
}
