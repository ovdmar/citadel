import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig, HookConfig } from "@citadel/config";
import type {
  AgentSession,
  CreateAgentSessionInput,
  CreateWorkspaceInput,
  Operation,
  Repo,
  Workspace,
} from "@citadel/contracts";
import { createId, nowIso, repoDisplayName, workspaceBranchName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { runCommandHook } from "@citadel/hooks";
import { ensureTmuxSession, killTmuxSession } from "@citadel/terminal";

export class OperationService {
  constructor(
    private readonly store: SqliteStore,
    private readonly config?: Pick<CitadelConfig, "hooks" | "repoDefaults" | "commandPolicy">,
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
    const workspace: Workspace = {
      id: createId("ws"),
      repoId: repo.id,
      name: input.name,
      path: workspacePath,
      branch,
      baseBranch: repo.defaultBranch,
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
      const startPoint = `${repo.defaultRemote}/${repo.defaultBranch}`;
      tryRunGit(repo.rootPath, ["worktree", "add", "-b", branch, workspacePath, startPoint]);
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
    runtime: { command: string; args: string[]; displayName: string },
  ) {
    const workspace = this.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
    if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
    const now = nowIso();
    const sessionName = `citadel_${workspace.id}_${createId("agent").slice(-8)}`;
    const tmux = await ensureTmuxSession({
      sessionName,
      cwd: workspace.path,
      command: runtime.command,
      args: runtime.args,
    });
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
    return session;
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
    return { operationId: operation.id, removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty };
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
  ) {
    this.store.addActivity({
      id: createId("evt"),
      type,
      source,
      repoId,
      workspaceId,
      operationId,
      message,
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
      this.activity(
        `hook.${event}`,
        "hook",
        `Hook ${hook.id} completed${result.stderr ? " with stderr" : ""}`,
        repo.id,
        workspace.id,
        operationId,
      );
    }
  }
}

function discoverDefaultBranch(rootPath: string) {
  try {
    const remoteHead = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
    })
      .trim()
      .replace("refs/remotes/origin/", "");
    return remoteHead || "main";
  } catch {
    return "main";
  }
}

function tryRunGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function workspaceIsDirty(workspacePath: string) {
  if (!fs.existsSync(workspacePath)) return false;
  const output = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  return output.trim().length > 0;
}
