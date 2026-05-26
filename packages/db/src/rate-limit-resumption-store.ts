import type { RateLimitResumption } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { rateLimitResumptionFromRow } from "./rows.js";

// Module-augment SqliteStore with rate-limit-resumption CRUD. Pattern matches
// scheduled-run-store.ts — assignment to prototype happens in index.ts after
// the class declaration to dodge ES-module-hoisting deadlock.
declare module "./index.js" {
  interface SqliteStore {
    insertRateLimitResumption(row: RateLimitResumption): RateLimitResumption;
    findPendingRateLimitResumption(): RateLimitResumption | null;
    listDueRateLimitResumptions(now: string): RateLimitResumption[];
    markRateLimitResumptionExecuted(id: string, executedAt: string): RateLimitResumption | null;
  }
}

export const rateLimitResumptionStoreMethods = {
  // Idempotent insert: at most one 'pending' row at a time (enforced by the
  // partial unique index). On UNIQUE conflict, return the existing pending row
  // instead of throwing.
  insertRateLimitResumption(this: SqliteStore, row: RateLimitResumption): RateLimitResumption {
    try {
      this.database
        .prepare(
          `INSERT INTO rate_limit_resumptions (id, scheduled_at, status, created_at, executed_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.scheduledAt, row.status, row.createdAt, row.executedAt ?? null);
      return row;
    } catch (err) {
      const message = (err as Error).message ?? "";
      if (message.includes("UNIQUE") || message.includes("constraint")) {
        const existing = this.findPendingRateLimitResumption();
        if (existing) return existing;
      }
      throw err;
    }
  },
  findPendingRateLimitResumption(this: SqliteStore): RateLimitResumption | null {
    const result = this.database.prepare("SELECT * FROM rate_limit_resumptions WHERE status = 'pending' LIMIT 1").get();
    if (!result) return null;
    return rateLimitResumptionFromRow(result as Record<string, unknown>);
  },
  listDueRateLimitResumptions(this: SqliteStore, now: string): RateLimitResumption[] {
    const rows = this.database
      .prepare(
        "SELECT * FROM rate_limit_resumptions WHERE status = 'pending' AND scheduled_at <= ? ORDER BY scheduled_at ASC",
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(rateLimitResumptionFromRow);
  },
  markRateLimitResumptionExecuted(this: SqliteStore, id: string, executedAt: string): RateLimitResumption | null {
    this.database
      .prepare(
        "UPDATE rate_limit_resumptions SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(executedAt, id);
    const row = this.database.prepare("SELECT * FROM rate_limit_resumptions WHERE id = ?").get(id);
    if (!row) return null;
    return rateLimitResumptionFromRow(row as Record<string, unknown>);
  },
};
