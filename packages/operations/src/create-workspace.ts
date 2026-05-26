// Extracted from `index.ts` to keep that file under the 800-line cap
// (`scripts/checks/file-size.ts`) and to colocate the funny-name retry
// loop + provisioning shape with the future async-create event emitter
// (Step 6 in workspace-nav-lifecycle plan).

import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig, HookConfig } from "@citadel/config";
import type { CreateWorkspaceInput, HookOutput, Operation, Repo, Workspace } from "@citadel/contracts";
import { createId, generateFunnyName, nowIso, workspaceBranchName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import {
  BranchInUseByWorktreeError,
  RemoteRefMissingError,
  WorkspaceNameTakenError,
  addWorktree,
  classifyWorktreeError,
  isUniqueWorkspaceNameViolation,
  tryRunGit,
} from "./helpers.js";

// Shared dep surface for the extracted workspace lifecycle modules. The
// service class in `index.ts` binds these to its private methods.
export type WorkspaceOpsDeps = {
  store: SqliteStore;
  config:
    | {
        hooks: HookConfig[];
        repoDefaults: {
          setupHookIds: string[];
          teardownHookIds: string[];
          appHookIds?: string[];
          actionHookIds?: string[];
        };
        commandPolicy: CitadelConfig["commandPolicy"];
      }
    | undefined;
  operation: (
    type: string,
    status: Operation["status"],
    repoId: string | null,
    workspaceId: string | null,
    progress: number,
    message: string,
  ) => Operation;
  logOp: (operationId: string, level: "info" | "warn" | "error", message: string) => void;
  activity: (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
    hookOutput?: HookOutput | null,
  ) => void;
  runWorkspaceHooks: (
    event: HookConfig["event"],
    hookIds: string[],
    repo: Repo,
    workspace: Workspace,
    operationId: string,
  ) => Promise<void>;
  runNotificationHooks: (
    event: HookConfig["event"],
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: unknown,
  ) => Promise<void>;
};

export async function createWorkspaceImpl(
  deps: WorkspaceOpsDeps,
  input: CreateWorkspaceInput,
): Promise<{ operationId: string; workspaceId: string }> {
  const repo = deps.store.listRepos().find((candidate) => candidate.id === input.repoId);
  if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
  const namespaceId = input.namespaceId ?? null;
  if (namespaceId) {
    const namespace = deps.store.findNamespace(namespaceId);
    if (!namespace) throw new Error(`Unknown namespace: ${namespaceId}`);
    if (namespace.archivedAt) throw new Error(`Namespace is archived: ${namespaceId}`);
  }
  const now = nowIso();
  const operation = deps.operation("workspace.create", "running", repo.id, null, 5, "Validating workspace request");
  const newBranch = input.newBranch?.trim() || null;
  const baseBranch = input.baseBranch?.trim() || repo.defaultBranch;
  const existingBranch = input.existingBranch?.trim() || null;

  // Resolve the workspace name with daemon-side funny-name generation when
  // the caller leaves it blank. The insert is wrapped in a retry loop so
  // unique-name collisions (rare with a 30×30 dictionary) don't surface as
  // operator-facing errors. After 5 fresh draws we fall back to a 4-char
  // random suffix to keep the create attempt from failing.
  const callerName = input.name.trim();
  const wantsGenerated = callerName.length === 0;
  let workspace: Workspace | null = null;
  let lastTriedName = callerName;
  let branch = "";
  let workspacePath = "";
  const maxAttempts = wantsGenerated ? 6 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let candidate = callerName;
    if (wantsGenerated) {
      candidate = attempt < 5 ? generateFunnyName() : `${generateFunnyName()}-${createId("x").slice(-4)}`;
    }
    lastTriedName = candidate;
    branch = newBranch ?? workspaceBranchName({ ...input, name: candidate });
    workspacePath = path.join(repo.worktreeParent, branch);
    const draft: Workspace = {
      id: createId("ws"),
      repoId: repo.id,
      name: candidate,
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
      deps.store.insertWorkspace(draft);
      workspace = draft;
      break;
    } catch (error) {
      if (isUniqueWorkspaceNameViolation(error)) {
        if (wantsGenerated && attempt < maxAttempts - 1) continue;
        deps.store.upsertOperation({
          ...operation,
          status: "failed",
          progress: 100,
          error: `workspace_name_taken: ${candidate}`,
          updatedAt: nowIso(),
        });
        throw new WorkspaceNameTakenError(repo.id, candidate);
      }
      throw error;
    }
  }
  if (!workspace) {
    // Defensive — the loop above either inserts or throws; this is unreachable.
    throw new WorkspaceNameTakenError(repo.id, lastTriedName);
  }
  deps.logOp(
    operation.id,
    "info",
    `Created workspace record name=${workspace.name} branch=${workspace.branch} base=${baseBranch} source=${input.source}`,
  );
  deps.store.upsertOperation({
    ...operation,
    workspaceId: workspace.id,
    progress: 20,
    message: "Fetching remote metadata",
  });
  fs.mkdirSync(repo.worktreeParent, { recursive: true });
  try {
    tryRunGit(repo.rootPath, ["fetch", "--prune", repo.defaultRemote]);
    deps.logOp(operation.id, "info", `Fetched ${repo.defaultRemote} (prune)`);
    const added = addWorktree(repo.rootPath, workspacePath, repo.defaultRemote, baseBranch, branch, existingBranch);
    deps.logOp(
      operation.id,
      "info",
      added.mode === "checkout"
        ? `Added worktree at ${workspacePath} on branch ${existingBranch}`
        : added.mode === "tracking"
          ? `Added worktree at ${workspacePath} tracking ${added.startPoint}`
          : `Added worktree at ${workspacePath} (new branch ${existingBranch ?? branch} from ${added.startPoint})`,
    );
    deps.store.upsertOperation({
      ...operation,
      workspaceId: workspace.id,
      progress: 75,
      message: "Running workspace setup hooks",
      updatedAt: nowIso(),
    });
    deps.logOp(
      operation.id,
      "info",
      `Running ${repo.setupHookIds.length} setup hook(s): ${repo.setupHookIds.join(", ") || "(none)"}`,
    );
    await deps.runWorkspaceHooks("workspace.setup", repo.setupHookIds, repo, workspace, operation.id);
    deps.store.updateWorkspaceLifecycle(workspace.id, "ready");
    deps.activity(
      "workspace.created",
      "system",
      `Created workspace ${workspace.name}`,
      repo.id,
      workspace.id,
      operation.id,
    );
    await deps.runNotificationHooks("workspace.created", repo, workspace, operation.id, { repo, workspace });
    deps.store.upsertOperation({
      ...operation,
      workspaceId: workspace.id,
      status: "succeeded",
      progress: 100,
      message: "Workspace ready",
      updatedAt: nowIso(),
    });
  } catch (error) {
    deps.store.updateWorkspaceLifecycle(workspace.id, "failed");
    const errorMessage = error instanceof Error ? error.message : "workspace_create_failed";
    deps.logOp(operation.id, "error", `Workspace create failed: ${errorMessage}`);
    deps.store.upsertOperation({
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
