// Note: imports the SqliteDatabase shim from index.ts rather than node:sqlite
// directly — the shim is what SqliteStore actually constructs (a createRequire-
// loaded DatabaseSync) and the typed surface we use everywhere internally.
import type { SqliteDatabase } from "./index.js";

// Per-workspace PR snapshot — read by the gh-scheduler on boot (hydrate) so
// cadence state (especially merged → never-poll) survives daemon restart
// without burning a boot-time gh call per workspace. Written by pr-routes
// after every successful gh pr view. All fields nullable; a row that has
// never been hydrated reads as all-null.
//
// Schema is part of v9 'workspaces-pr-snapshot' (see migrate.ts). Extracted
// out of index.ts to keep that file under the 800-line check:size gate.

export type WorkspacePrSnapshot = {
  prNumber: number | null;
  prState: "open" | "closed" | "merged" | null;
  lastFetchAt: string | null;
  lastChecksGreenAt: string | null;
  lastHeadSha: string | null;
  lastHeadShaChangedAt: string | null;
  lastMergeStateStatus: string | null;
};

export function normalizePrState(raw: string | null): "open" | "closed" | "merged" | null {
  if (raw === "open" || raw === "closed" || raw === "merged") return raw;
  return null;
}

export function getWorkspacePrSnapshot(database: SqliteDatabase, workspaceId: string): WorkspacePrSnapshot | null {
  const row = database
    .prepare(
      `SELECT pr_number          AS prNumber,
              pr_state           AS prState,
              pr_last_fetch_at   AS lastFetchAt,
              pr_last_checks_green_at AS lastChecksGreenAt,
              pr_last_head_sha   AS lastHeadSha,
              pr_last_head_sha_changed_at AS lastHeadShaChangedAt,
              pr_last_merge_state_status  AS lastMergeStateStatus
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as
    | {
        prNumber: number | null;
        prState: string | null;
        lastFetchAt: string | null;
        lastChecksGreenAt: string | null;
        lastHeadSha: string | null;
        lastHeadShaChangedAt: string | null;
        lastMergeStateStatus: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    prNumber: row.prNumber ?? null,
    prState: normalizePrState(row.prState),
    lastFetchAt: row.lastFetchAt ?? null,
    lastChecksGreenAt: row.lastChecksGreenAt ?? null,
    lastHeadSha: row.lastHeadSha ?? null,
    lastHeadShaChangedAt: row.lastHeadShaChangedAt ?? null,
    lastMergeStateStatus: row.lastMergeStateStatus ?? null,
  };
}

// Partial update — pass only fields the caller wants to change. Setting a
// field to null explicitly clears it (e.g., clearing lastChecksGreenAt when
// a previously-green PR sees a check fail). Omitted fields are untouched.
export function updateWorkspacePrSnapshot(
  database: SqliteDatabase,
  workspaceId: string,
  patch: Partial<WorkspacePrSnapshot>,
): void {
  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  const map: Array<[keyof WorkspacePrSnapshot, string]> = [
    ["prNumber", "pr_number"],
    ["prState", "pr_state"],
    ["lastFetchAt", "pr_last_fetch_at"],
    ["lastChecksGreenAt", "pr_last_checks_green_at"],
    ["lastHeadSha", "pr_last_head_sha"],
    ["lastHeadShaChangedAt", "pr_last_head_sha_changed_at"],
    ["lastMergeStateStatus", "pr_last_merge_state_status"],
  ];
  for (const [key, column] of map) {
    if (key in patch) {
      fields.push(`${column} = ?`);
      values.push(patch[key] ?? null);
    }
  }
  if (fields.length === 0) return;
  values.push(workspaceId);
  database.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...(values as unknown[]));
}
