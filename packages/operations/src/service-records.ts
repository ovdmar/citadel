import type { ActivityEvent, HookOutput, Operation } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";

export function createOperationRecord(
  store: SqliteStore,
  input: {
    type: string;
    status: Operation["status"];
    repoId: string | null;
    workspaceId: string | null;
    progress: number;
    message: string;
  },
) {
  const now = nowIso();
  const operation: Operation = {
    id: createId("op"),
    type: input.type,
    status: input.status,
    repoId: input.repoId,
    workspaceId: input.workspaceId,
    progress: input.progress,
    message: input.message,
    error: null,
    logs: [{ level: "info", message: input.message, at: now }],
    retriable: false,
    retryInput: null,
    createdAt: now,
    updatedAt: now,
  };
  store.upsertOperation(operation);
  return operation;
}

export function addActivityRecord(
  store: SqliteStore,
  input: {
    type: string;
    source: ActivityEvent["source"];
    repoId: string | null;
    workspaceId: string | null;
    operationId: string | null;
    message: string;
    hookOutput?: HookOutput | null | undefined;
  },
) {
  store.addActivity({
    id: createId("evt"),
    type: input.type,
    source: input.source,
    repoId: input.repoId,
    workspaceId: input.workspaceId,
    operationId: input.operationId,
    message: input.message,
    hookOutput: input.hookOutput ?? null,
    createdAt: nowIso(),
  });
}
