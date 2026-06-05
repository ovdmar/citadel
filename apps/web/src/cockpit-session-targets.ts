import type { Workspace, WorkspaceSession, WorktreeCheckout } from "@citadel/contracts";

export type WorkspaceTargetType = "workspace_home" | "worktree_checkout";

export function sessionMatchesTarget(
  session: WorkspaceSession,
  workspace: Workspace,
  targetType: WorkspaceTargetType,
  checkoutId: string | null,
): boolean {
  if (workspace.mode !== "structured") return true;
  if (targetType === "workspace_home") return (session.targetType ?? "workspace_home") === "workspace_home";
  return session.checkoutId === checkoutId;
}

export function targetKeyForSession(session: WorkspaceSession): string {
  return session.targetType === "worktree_checkout" && session.checkoutId ? `checkout:${session.checkoutId}` : "home";
}

export function checkoutIdFromTargetKey(targetKey: string, checkouts: WorktreeCheckout[]): string | null {
  if (!targetKey.startsWith("checkout:")) return null;
  const checkoutId = targetKey.slice("checkout:".length);
  return checkouts.some((checkout) => checkout.id === checkoutId) ? checkoutId : null;
}

export function targetLabel(
  targetType: WorkspaceTargetType,
  checkoutId: string | null,
  checkouts: WorktreeCheckout[],
): string {
  if (targetType === "workspace_home") return "Home";
  return checkouts.find((checkout) => checkout.id === checkoutId)?.name ?? "Checkout";
}

export function shouldShowInspectorPanel(
  workspace: Workspace | null | undefined,
  targetType: WorkspaceTargetType,
): boolean {
  return workspace?.mode !== "structured" || targetType === "worktree_checkout";
}
