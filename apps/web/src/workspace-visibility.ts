import type { Repo, Workspace } from "@citadel/contracts";

export function isMainRepoWorkspace(workspace: Workspace): boolean {
  return workspace.kind === "root" && workspace.repoId !== null && workspace.mode !== "structured";
}

export function workspaceVisibleInNavigator(workspace: Workspace, repos: readonly Repo[]): boolean {
  if (!isMainRepoWorkspace(workspace)) return true;
  const repo = repos.find((entry) => entry.id === workspace.repoId);
  return repo?.showMainWorkspace === true;
}

export function visibleNavigatorWorkspaces(workspaces: readonly Workspace[], repos: readonly Repo[]): Workspace[] {
  return workspaces.filter((workspace) => workspaceVisibleInNavigator(workspace, repos));
}
