import type { PlanRegistration } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";

declare module "./index.js" {
  interface SqliteStore {
    insertPlanRegistration(row: PlanRegistration): void;
    findPlanRegistration(id: string): PlanRegistration | null;
    listPlanRegistrationsForWorkspace(workspaceId: string): PlanRegistration[];
    deletePlanRegistration(id: string): boolean;
  }
}

export const planRegistrationStoreMethods = {
  insertPlanRegistration(this: SqliteStore, row: PlanRegistration) {
    this.database
      .prepare(
        `INSERT INTO plan_registrations (id, workspace_id, path, summary, registered_at, registered_by_session_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.workspaceId, row.path, row.summary, row.registeredAt, row.registeredBySessionId);
  },

  findPlanRegistration(this: SqliteStore, id: string): PlanRegistration | null {
    const row = this.database.prepare("SELECT * FROM plan_registrations WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return planRegistrationFromRow(row);
  },

  listPlanRegistrationsForWorkspace(this: SqliteStore, workspaceId: string): PlanRegistration[] {
    const rows = this.database
      .prepare("SELECT * FROM plan_registrations WHERE workspace_id = ? ORDER BY registered_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(planRegistrationFromRow);
  },

  deletePlanRegistration(this: SqliteStore, id: string): boolean {
    const result = this.database.prepare("DELETE FROM plan_registrations WHERE id = ?").run(id);
    return (result.changes ?? 0) > 0;
  },
};

function planRegistrationFromRow(row: Record<string, unknown>): PlanRegistration {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    path: String(row.path),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    registeredAt: String(row.registered_at),
    registeredBySessionId:
      row.registered_by_session_id === null || row.registered_by_session_id === undefined
        ? null
        : String(row.registered_by_session_id),
  };
}
