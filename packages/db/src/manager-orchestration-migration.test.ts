import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function freshDb(): DatabaseSync {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-v19-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  return (store as unknown as { database: DatabaseSync }).database;
}

describe("manager orchestration migration (v19)", () => {
  it("creates delivery-unit, action-ledger, provider-fact, authority, and notification tables", () => {
    const db = freshDb();
    for (const table of [
      "workspace_plan_delivery_units",
      "workspace_plan_dependency_edges",
      "manager_action_ledger",
      "provider_issue_facts",
      "issue_transition_attempts",
      "checkout_pr_facts",
      "checkout_check_facts",
      "agent_tool_authorities",
      "local_notification_events",
    ]) {
      const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
        | { name: string }
        | undefined;
      expect(row?.name).toBe(table);
    }
    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 19").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("manager-orchestration-ledger");
    const activeIndex = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'idx_manager_action_ledger_active_scope_action'",
      )
      .get() as { name: string } | undefined;
    expect(activeIndex?.name).toBe("idx_manager_action_ledger_active_scope_action");
  });

  it("adds nullable checkout delivery-unit, review invalidation, and session manager-action columns", () => {
    const db = freshDb();
    expect(columnNames(db, "workspace_checkouts")).toEqual(
      expect.arrayContaining([
        "delivery_unit_key",
        "delivery_plan_version_id",
        "manager_status",
        "manager_status_reason",
        "manager_status_updated_at",
      ]),
    );
    expect(columnNames(db, "checkout_review_artifacts")).toEqual(
      expect.arrayContaining([
        "invalidated_at",
        "invalidated_reason",
        "human_waived_at",
        "human_waived_by",
        "human_waiver_reason",
      ]),
    );
    expect(columnNames(db, "workspace_sessions")).toContain("manager_action_id");
  });
});

function columnNames(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
