import type { ActivityEvent } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { cancelOperationInStore } from "./helpers.js";

type ActivityFn = (
  type: string,
  source: ActivityEvent["source"],
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
) => void;

export function cancelOperation(
  deps: { store: SqliteStore; nowIso: () => string; activity: ActivityFn },
  operationId: string,
) {
  const result = cancelOperationInStore(deps.store, operationId, deps.nowIso);
  if (result.cancelled && result.operation)
    deps.activity(
      "operation.cancelled",
      "user",
      `Cancelled ${result.operation.type}`,
      result.operation.repoId,
      result.operation.workspaceId,
      result.operation.id,
    );
  return { cancelled: result.cancelled, reason: result.reason };
}
