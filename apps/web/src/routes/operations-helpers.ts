import type { Operation } from "@citadel/contracts";

// Pure helper consumed by OperationsView's `?id=…` deep-link. Returns whether
// the requested operation id exists in the current list, so the view can show
// the "not found" banner when the link points at a purged operation.
//
// Kept out of operations.tsx because the route file lacks a unit-test seam
// (no React testing library in this repo yet); a pure helper is testable.
export function findHighlightedOperation(operations: Operation[], id: string | undefined): Operation | null {
  if (!id) return null;
  return operations.find((op) => op.id === id) ?? null;
}

export function operationHighlightStatus(
  operations: Operation[],
  id: string | undefined,
): "none" | "found" | "missing" {
  if (!id) return "none";
  return operations.some((op) => op.id === id) ? "found" : "missing";
}
