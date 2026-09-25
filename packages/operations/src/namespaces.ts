import type { CreateNamespaceInput, Namespace, ReorderNamespacesInput, UpdateNamespaceInput } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";

export type NamespaceServiceDeps = {
  store: SqliteStore;
  activity: (type: string, message: string) => void;
};

export type AssignWorkspaceResult =
  | { assigned: true; workspaceId: string; namespaceId: string | null }
  | { assigned: false; reason: "workspace_not_found" | "namespace_not_found" | "namespace_archived" };

export type CreateNamespaceResult = { namespace: Namespace; created: boolean };
export type ReorderNamespacesResult =
  | { reordered: true; namespaces: Namespace[] }
  | { reordered: false; reason: "namespace_not_found" | "namespace_archived" | "namespace_order_mismatch" };

export function listNamespaces(store: SqliteStore, includeArchived = false): Namespace[] {
  return store.listNamespaces(includeArchived);
}

export function createNamespace(deps: NamespaceServiceDeps, input: CreateNamespaceInput): CreateNamespaceResult {
  const name = input.name.trim();
  const colorPatch = input.color !== undefined ? { color: input.color ?? null } : {};
  const existing = deps.store.findNamespaceByName(name);
  if (existing) {
    if (!existing.archivedAt) return { namespace: existing, created: false };
    // Same name was previously archived; reactivate it instead of hitting the
    // UNIQUE(name) constraint. Honor any color override the caller supplied.
    const restored = deps.store.restoreNamespace(existing.id, colorPatch);
    if (!restored) return { namespace: existing, created: false };
    deps.activity("namespace.restored", `Restored namespace ${restored.name}`);
    return { namespace: restored, created: true };
  }
  const now = nowIso();
  const namespace: Namespace = {
    id: createId("ns"),
    name,
    color: input.color ?? null,
    position: nextNamespacePosition(deps.store.listNamespaces(true)),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  deps.store.insertNamespace(namespace);
  deps.activity("namespace.created", `Created namespace ${namespace.name}`);
  return { namespace, created: true };
}

export function restoreNamespace(deps: NamespaceServiceDeps, id: string): Namespace | null {
  const restored = deps.store.restoreNamespace(id);
  if (restored) deps.activity("namespace.restored", `Restored namespace ${restored.name}`);
  return restored;
}

export function renameNamespace(deps: NamespaceServiceDeps, id: string, patch: UpdateNamespaceInput): Namespace | null {
  const cleanPatch: { name?: string; color?: string | null } = {};
  if (typeof patch.name === "string") cleanPatch.name = patch.name.trim();
  if (patch.color !== undefined) cleanPatch.color = patch.color;
  if (cleanPatch.name === undefined && cleanPatch.color === undefined) {
    // No-op patch — return the current state without logging activity.
    return deps.store.findNamespace(id);
  }
  const next = deps.store.updateNamespace(id, cleanPatch);
  if (next) deps.activity("namespace.updated", `Updated namespace ${next.name}`);
  return next;
}

export function archiveNamespace(deps: NamespaceServiceDeps, id: string): Namespace | null {
  const archived = deps.store.archiveNamespace(id);
  if (archived) deps.activity("namespace.archived", `Archived namespace ${archived.name}`);
  return archived;
}

export function reorderNamespaces(deps: NamespaceServiceDeps, input: ReorderNamespacesInput): ReorderNamespacesResult {
  const namespaces = deps.store.listNamespaces(true);
  const byId = new Map(namespaces.map((namespace) => [namespace.id, namespace]));
  if (new Set(input.namespaceIds).size !== input.namespaceIds.length) {
    return { reordered: false, reason: "namespace_order_mismatch" };
  }
  for (const id of input.namespaceIds) {
    const namespace = byId.get(id);
    if (!namespace) return { reordered: false, reason: "namespace_not_found" };
    if (namespace.archivedAt) return { reordered: false, reason: "namespace_archived" };
  }
  const activeIds = namespaces.filter((namespace) => !namespace.archivedAt).map((namespace) => namespace.id);
  if (activeIds.length !== input.namespaceIds.length) return { reordered: false, reason: "namespace_order_mismatch" };
  const expected = new Set(activeIds);
  if (input.namespaceIds.some((id) => !expected.has(id)))
    return { reordered: false, reason: "namespace_order_mismatch" };
  const reordered = deps.store.reorderNamespaces(input.namespaceIds);
  deps.activity("namespace.reordered", "Reordered namespaces");
  return { reordered: true, namespaces: reordered };
}

export function assignWorkspaceToNamespace(
  deps: NamespaceServiceDeps,
  input: { workspaceId: string; namespaceId: string | null },
): AssignWorkspaceResult {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) return { assigned: false, reason: "workspace_not_found" };
  if (input.namespaceId) {
    const namespace = deps.store.findNamespace(input.namespaceId);
    if (!namespace) return { assigned: false, reason: "namespace_not_found" };
    if (namespace.archivedAt) return { assigned: false, reason: "namespace_archived" };
  }
  const updated = deps.store.setWorkspaceNamespace(input.workspaceId, input.namespaceId);
  if (!updated) return { assigned: false, reason: "workspace_not_found" };
  const label = input.namespaceId ? `namespace ${input.namespaceId}` : "no namespace";
  deps.activity("namespace.assigned", `Assigned workspace ${workspace.name} to ${label}`);
  return { assigned: true, workspaceId: input.workspaceId, namespaceId: input.namespaceId };
}

function nextNamespacePosition(namespaces: readonly Namespace[]): number {
  const max = namespaces.reduce((current, namespace) => Math.max(current, namespace.position), 0);
  return max + 1024;
}
