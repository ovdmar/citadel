import type { GroupNode } from "./navigator-groups.js";
import { applyLocalOrder } from "./navigator-order.js";

export function focusWorkspaceIdAfterDrop(visibleIds: readonly string[], workspaceId: string): string | null {
  const index = visibleIds.indexOf(workspaceId);
  if (index === -1) return null;
  for (let i = index + 1; i < visibleIds.length; i += 1) {
    const id = visibleIds[i];
    if (id && id !== workspaceId) return id;
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const id = visibleIds[i];
    if (id && id !== workspaceId) return id;
  }
  return null;
}

export function renderedWorkspaceIdsFromTree(
  nodes: readonly GroupNode[],
  navigatorOrder: Record<string, string[]>,
): string[] {
  const ids: string[] = [];
  const walk = (list: readonly GroupNode[]) => {
    for (const node of list) {
      if (node.kind === "leaf") {
        const ordered = applyLocalOrder(node.workspaces, navigatorOrder[node.path]);
        for (const entry of ordered) ids.push(entry.workspace.id);
      } else {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return ids;
}
