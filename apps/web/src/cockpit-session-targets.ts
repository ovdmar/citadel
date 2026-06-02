import type { Workspace, WorkspaceSession, WorktreeCheckout } from "@citadel/contracts";

export function sessionMatchesTarget(
  session: WorkspaceSession,
  workspace: Workspace,
  targetType: "workspace_home" | "worktree_checkout",
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
  targetType: "workspace_home" | "worktree_checkout",
  checkoutId: string | null,
  checkouts: WorktreeCheckout[],
): string {
  if (targetType === "workspace_home") return "Home";
  return checkouts.find((checkout) => checkout.id === checkoutId)?.name ?? "Checkout";
}
