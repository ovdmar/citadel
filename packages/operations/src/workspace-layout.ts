import fs from "node:fs";
import path from "node:path";
import type { ExecutionTarget, Workspace, WorktreeCheckout } from "@citadel/contracts";

export function workspaceRootPath(workspace: Workspace): string {
  return workspace.rootPath ?? workspace.path;
}

export function executionTargetCwd(input: {
  workspace: Workspace;
  checkout?: WorktreeCheckout | null;
  targetType: ExecutionTarget["type"];
}): string {
  if (input.targetType === "workspace_home") return workspaceRootPath(input.workspace);
  if (!input.checkout) throw new Error("checkout_required");
  return input.checkout.path;
}

export type ResolvedExecutionTarget =
  | { ok: true; target: ExecutionTarget }
  | { ok: false; error: "outside_registered_workspace" | "workspace_not_found" };

export function resolveExecutionTargetForCwd(input: {
  cwd: string;
  workspaces: Workspace[];
  checkouts: WorktreeCheckout[];
  realpath?: (candidate: string) => string;
}): ResolvedExecutionTarget {
  const realpath = input.realpath ?? realpathIfExists;
  const resolvedCwd = realpath(path.resolve(input.cwd));
  const sortedCheckouts = [...input.checkouts].sort((a, b) => b.path.length - a.path.length);
  for (const checkout of sortedCheckouts) {
    const resolvedCheckout = realpath(path.resolve(checkout.path));
    if (containsPath(resolvedCheckout, resolvedCwd)) {
      return {
        ok: true,
        target: {
          type: "worktree_checkout",
          workspaceId: checkout.workspaceId,
          checkoutId: checkout.id,
          cwd: resolvedCwd,
        },
      };
    }
  }
  const sortedWorkspaces = [...input.workspaces].sort(
    (a, b) => workspaceRootPath(b).length - workspaceRootPath(a).length,
  );
  for (const workspace of sortedWorkspaces) {
    const resolvedRoot = realpath(path.resolve(workspaceRootPath(workspace)));
    if (containsPath(resolvedRoot, resolvedCwd)) {
      return { ok: true, target: { type: "workspace_home", workspaceId: workspace.id, cwd: resolvedCwd } };
    }
  }
  return { ok: false, error: input.workspaces.length ? "outside_registered_workspace" : "workspace_not_found" };
}

function realpathIfExists(candidate: string): string {
  try {
    return fs.realpathSync.native(candidate);
  } catch {
    return candidate;
  }
}

function containsPath(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
