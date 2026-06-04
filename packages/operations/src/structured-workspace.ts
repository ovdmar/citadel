import fs from "node:fs";
import path from "node:path";
import type {
  CreateWorkspaceCheckoutInput,
  CreateWorkspaceInput,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { WorkspaceOpsDeps } from "./create-workspace.js";
import { addWorktree, tryRunGit } from "./helpers.js";
import { workspaceRootPath } from "./workspace-layout.js";

export async function createStructuredWorkspaceShell(
  deps: WorkspaceOpsDeps,
  input: CreateWorkspaceInput,
): Promise<{ operationId: string; workspaceId: string }> {
  if (!input.rootPath) throw new Error("structured_workspace_root_required");
  const rootPath = path.resolve(input.rootPath);
  const now = nowIso();
  const operation = deps.operation("workspace.create.structured", "running", null, null, 10, "Creating workspace Home");
  fs.mkdirSync(path.join(rootPath, ".citadel"), { recursive: true });
  const workspace: Workspace = {
    id: createId("ws"),
    repoId: null,
    name: input.name.trim() || path.basename(rootPath),
    path: rootPath,
    rootPath,
    mode: "structured",
    branch: "home",
    baseBranch: input.baseBranch?.trim() || "main",
    source: input.source,
    kind: "root",
    lifecyclePhase: "discovery_inputs",
    parentIssue: input.parentIssue ?? null,
    prUrl: null,
    issueKey: input.parentIssue?.key ?? input.issueKey ?? null,
    issueTitle: input.parentIssue?.title ?? input.issueTitle ?? null,
    issueUrl: input.parentIssue?.url ?? input.issueUrl ?? null,
    slackThreadUrl: input.slackThreadUrl ?? null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: input.namespaceId ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  deps.store.insertWorkspace(workspace);
  deps.store.insertWorkspaceManager({
    id: createId("mgr"),
    workspaceId: workspace.id,
    pauseState: "running",
    heartbeatIntervalSeconds: 300,
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
  });
  fs.writeFileSync(
    path.join(rootPath, ".citadel", "workspace.json"),
    `${JSON.stringify({ version: 1, workspaceId: workspace.id, mode: "structured", name: workspace.name }, null, 2)}\n`,
  );
  deps.store.upsertOperation({
    ...operation,
    workspaceId: workspace.id,
    status: "succeeded",
    progress: 100,
    message: "Structured workspace Home ready",
    updatedAt: nowIso(),
  });
  deps.activity(
    "workspace.created",
    "system",
    `Created structured workspace ${workspace.name}`,
    null,
    workspace.id,
    operation.id,
  );
  return { operationId: operation.id, workspaceId: workspace.id };
}

export async function createWorkspaceCheckoutImpl(
  deps: WorkspaceOpsDeps,
  input: CreateWorkspaceCheckoutInput,
): Promise<{ operationId: string; checkoutId: string }> {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const repo = deps.store.listRepos().find((candidate) => candidate.id === input.repoId);
  if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
  const checkoutName = input.name.trim();
  if (!isSafeCheckoutName(checkoutName)) throw new Error("checkout_name_invalid");
  const checkoutPath = path.join(workspaceRootPath(workspace), checkoutName);
  const branch = input.branch.trim();
  const baseBranch = input.baseBranch?.trim() || repo.defaultBranch;
  const now = nowIso();
  const operation = deps.operation(
    "workspace.checkout.create",
    "running",
    repo.id,
    workspace.id,
    15,
    "Creating checkout",
  );
  fs.mkdirSync(workspaceRootPath(workspace), { recursive: true });
  try {
    tryRunGit(repo.rootPath, ["fetch", "--prune", repo.defaultRemote]);
    if (input.source === "upstream_checkout") {
      const upstream = input.upstreamCheckoutId ? deps.store.findWorkspaceCheckout(input.upstreamCheckoutId) : null;
      if (!upstream) throw new Error("upstream_checkout_required");
      tryRunGit(repo.rootPath, ["worktree", "add", "-b", branch, checkoutPath, upstream.branch]);
    } else {
      const existingBranch = input.source === "existing_branch" || input.source === "pr" ? branch : null;
      addWorktree(repo.rootPath, checkoutPath, repo.defaultRemote, baseBranch, branch, existingBranch);
    }
    const checkout: WorktreeCheckout = {
      id: createId("co"),
      workspaceId: workspace.id,
      repoId: repo.id,
      name: checkoutName,
      path: checkoutPath,
      branch,
      baseBranch,
      issue: input.issue ?? null,
      intendedPr: null,
      stackParentCheckoutId: input.upstreamCheckoutId ?? null,
      inferredPurpose: null,
      deliveryUnitKey: input.deliveryUnitKey ?? null,
      deliveryPlanVersionId: input.deliveryPlanVersionId ?? null,
      gateStatus: "not_started",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    deps.store.insertWorkspaceCheckout(checkout);
    deps.store.upsertOperation({
      ...operation,
      status: "succeeded",
      progress: 100,
      message: `Checkout ${checkoutName} ready`,
      updatedAt: nowIso(),
    });
    deps.activity(
      "workspace.checkout.created",
      "system",
      `Created checkout ${checkoutName}`,
      repo.id,
      workspace.id,
      operation.id,
    );
    return { operationId: operation.id, checkoutId: checkout.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : "checkout_create_failed";
    deps.store.upsertOperation({ ...operation, status: "failed", progress: 100, error: message, updatedAt: nowIso() });
    throw error;
  }
}

function isSafeCheckoutName(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}
