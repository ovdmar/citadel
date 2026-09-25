import type { Namespace } from "@citadel/contracts";

export const NAMESPACE_REORDER_MIME = "application/x-citadel-namespace-id";

export function isNamespaceReorderDrag(types: readonly string[]): boolean {
  return types.includes(NAMESPACE_REORDER_MIME);
}

export function namespaceIdsAfterMove(
  namespaces: readonly Namespace[],
  draggedId: string,
  targetId: string,
): string[] | null {
  if (!draggedId || draggedId === targetId) return null;
  const ids = namespaces.map((namespace) => namespace.id);
  const draggedIndex = ids.indexOf(draggedId);
  const targetIndex = ids.indexOf(targetId);
  if (draggedIndex === -1 || targetIndex === -1) return null;
  const without = ids.filter((id) => id !== draggedId);
  const insertIndex = without.indexOf(targetId) + (draggedIndex < targetIndex ? 1 : 0);
  return [...without.slice(0, insertIndex), draggedId, ...without.slice(insertIndex)];
}
