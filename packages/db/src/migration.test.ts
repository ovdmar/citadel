import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-migration-"));
  dirs.push(dir);
  return path.join(dir, "citadel.sqlite");
}

// Sets up a pre-migration agent_sessions row with a legacy status value, then
// re-opens the database through SqliteStore so the migration runs against the
// existing row. The migration's data-backfill UPDATE statements are
// idempotent — they'll run every boot, but only touch matching rows.
function seedLegacySession(dbPath: string, opts: { id: string; legacyStatus: "waiting" | "orphaned" | "idle" }) {
  // First, open a vanilla SqliteStore so the table exists. It'll create
  // empty schema_migrations. We DON'T insert via store.insertSession here
  // (signature requires new fields); we go around it with raw SQL so we
  // can write any legacy status value.
  const store = new SqliteStore(dbPath);
  store.migrate();
  // Now reach into the database and write the legacy row directly. The
  // ALTER ADD COLUMN statements have already run, so the new columns exist
  // but the data-backfill UPDATE statements are idempotent and will run
  // again on the next store construction.
  const db = (store as unknown as { database: DatabaseSync }).database;
  // Seed parent rows in FK order: repos → workspaces → agent_sessions.
  db.exec(`INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent, setup_hook_ids, teardown_hook_ids, provider_ids, deploy_hook_command, created_at, updated_at, archived_at)
    VALUES ('repo_test', 'r', '/tmp/r', 'main', 'origin', '/tmp/w', '[]', '[]', '[]', NULL, '${new Date().toISOString()}', '${new Date().toISOString()}', NULL)
    ON CONFLICT(id) DO NOTHING`);
  db.exec(`INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url, issue_key, issue_title, slack_thread_url, section, pinned, lifecycle, dirty, created_at, updated_at, archived_at)
    VALUES ('ws_test', 'repo_test', 'ws', '/tmp/ws', 'main', 'main', 'scratch', 'worktree', NULL, NULL, NULL, NULL, 'backlog', 0, 'ready', 0, '${new Date().toISOString()}', '${new Date().toISOString()}', NULL)
    ON CONFLICT(id) DO NOTHING`);
  db.exec(
    `INSERT INTO agent_sessions (id, workspace_id, runtime_id, display_name, status, status_reason, last_status_at, last_output_at, ended_at, exit_code, transport, tmux_session_name, tmux_session_id, created_at, updated_at)
     VALUES ('${opts.id}', 'ws_test', 'claude-code', 'test', '${opts.legacyStatus}', NULL, '2026-05-17T00:00:00.000Z', NULL, NULL, NULL, 'disconnected', 'citadel_test', '$1', '2026-05-17T00:00:00.000Z', '2026-05-17T00:00:00.000Z')`,
  );
}

describe("agent-status migration", () => {
  it("maps waiting → running with statusReason='migrated_from_waiting'", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_w", legacyStatus: "waiting" });
    // Re-open the store; migrations run again and apply the backfill.
    const store = new SqliteStore(dbPath);
    store.migrate();
    const sessions = store.listSessions();
    const row = sessions.find((s) => s.id === "sess_w");
    expect(row?.status).toBe("running");
    expect(row?.statusReason).toBe("migrated_from_waiting");
  });

  it("maps orphaned → unknown with statusReason='migrated_from_orphaned'", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_o", legacyStatus: "orphaned" });
    const store = new SqliteStore(dbPath);
    store.migrate();
    const row = store.listSessions().find((s) => s.id === "sess_o");
    expect(row?.status).toBe("unknown");
    expect(row?.statusReason).toBe("migrated_from_orphaned");
  });

  it("preserves idle status and stamps statusReason='migrated_legacy_idle'", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_i", legacyStatus: "idle" });
    const store = new SqliteStore(dbPath);
    store.migrate();
    const row = store.listSessions().find((s) => s.id === "sess_i");
    expect(row?.status).toBe("idle");
    expect(row?.statusReason).toBe("migrated_legacy_idle");
  });

  it("backfills last_status_at = updated_at on rows with placeholder default", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    db.exec(`INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent, setup_hook_ids, teardown_hook_ids, provider_ids, deploy_hook_command, created_at, updated_at, archived_at)
      VALUES ('repo_test', 'r', '/tmp/r', 'main', 'origin', '/tmp/w', '[]', '[]', '[]', NULL, '${new Date().toISOString()}', '${new Date().toISOString()}', NULL)
      ON CONFLICT(id) DO NOTHING`);
    db.exec(`INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url, issue_key, issue_title, slack_thread_url, section, pinned, lifecycle, dirty, created_at, updated_at, archived_at)
      VALUES ('ws_test', 'repo_test', 'ws', '/tmp/ws', 'main', 'main', 'scratch', 'worktree', NULL, NULL, NULL, NULL, 'backlog', 0, 'ready', 0, '${new Date().toISOString()}', '${new Date().toISOString()}', NULL)
      ON CONFLICT(id) DO NOTHING`);
    // Insert with the placeholder default value to simulate a pre-backfill row.
    db.exec(
      `INSERT INTO agent_sessions (id, workspace_id, runtime_id, display_name, status, status_reason, last_status_at, transport, tmux_session_name, tmux_session_id, created_at, updated_at)
       VALUES ('sess_pre', 'ws_test', 'claude-code', 't', 'running', NULL, '1970-01-01T00:00:00.000Z', 'disconnected', 'citadel_test', '$1', '2026-05-20T12:00:00.000Z', '2026-05-20T14:30:00.000Z')`,
    );
    // Re-open to trigger another migration pass (idempotent backfill).
    const store2 = new SqliteStore(dbPath);
    store2.migrate();
    const row = store2.listSessions().find((s) => s.id === "sess_pre");
    expect(row?.lastStatusAt).toBe("2026-05-20T14:30:00.000Z");
  });

  it("is idempotent — repeated boots don't re-stamp already-migrated rows", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_w2", legacyStatus: "waiting" });
    // First migration pass.
    const store1 = new SqliteStore(dbPath);
    store1.migrate();
    const firstPass = store1.listSessions().find((s) => s.id === "sess_w2");
    expect(firstPass?.status).toBe("running");
    expect(firstPass?.statusReason).toBe("migrated_from_waiting");
    // Second migration pass — backfill UPDATEs target only matching rows.
    const store2 = new SqliteStore(dbPath);
    store2.migrate();
    const secondPass = store2.listSessions().find((s) => s.id === "sess_w2");
    // The row is now status=running, statusReason=migrated_from_waiting.
    // The first UPDATE (WHERE status='waiting') no longer matches.
    // The last_status_at backfill (WHERE last_status_at='1970-01-01...') no
    // longer matches either. State is stable.
    expect(secondPass?.status).toBe("running");
    expect(secondPass?.statusReason).toBe("migrated_from_waiting");
  });
});
