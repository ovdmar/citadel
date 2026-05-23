import type { CreateNamespaceInput, Namespace, UpdateNamespaceInput } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";

export type NamespaceServiceDeps = {
  store: SqliteStore;
  activity: (type: string, message: string) => void;
};

export type AssignWorkspaceResult =
  | { assigned: true; workspaceId: string; namespaceId: string | null }
  | { assigned: false; reason: "workspace_not_found" | "namespace_not_found" | "namespace_archived" };

export function listNamespaces(store: SqliteStore, includeArchived = false): Namespace[] {
  return store.listNamespaces(includeArchived);
}

export function createNamespace(deps: NamespaceServiceDeps, input: CreateNamespaceInput): Namespace {
  const name = input.name.trim();
  const existing = deps.store.findNamespaceByName(name);
  if (existing && !existing.archivedAt) return existing;
  const now = nowIso();
  const namespace: Namespace = {
    id: createId("ns"),
    name,
    color: input.color ?? null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  deps.store.insertNamespace(namespace);
  deps.activity("namespace.created", `Created namespace ${namespace.name}`);
  return namespace;
}

export function renameNamespace(deps: NamespaceServiceDeps, id: string, patch: UpdateNamespaceInput): Namespace | null {
  const cleanPatch: { name?: string; color?: string | null } = {};
  if (typeof patch.name === "string") cleanPatch.name = patch.name.trim();
  if (patch.color !== undefined) cleanPatch.color = patch.color;
  const next = deps.store.updateNamespace(id, cleanPatch);
  if (next) deps.activity("namespace.updated", `Updated namespace ${next.name}`);
  return next;
}

export function archiveNamespace(deps: NamespaceServiceDeps, id: string): Namespace | null {
  const archived = deps.store.archiveNamespace(id);
  if (archived) deps.activity("namespace.archived", `Archived namespace ${archived.name}`);
  return archived;
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
