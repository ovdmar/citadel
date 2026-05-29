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

describe("auto-resume migration (version 8)", () => {
  it("adds rate_limit_resume_attempts (NOT NULL DEFAULT 0), next_resume_at, and last_resume_from_rate_limit_at columns", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const cols = db.prepare("PRAGMA table_info(agent_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const attempts = cols.find((c) => c.name === "rate_limit_resume_attempts");
    expect(attempts).toBeDefined();
    expect(attempts?.type.toUpperCase()).toBe("INTEGER");
    expect(attempts?.notnull).toBe(1);
    expect(attempts?.dflt_value).toBe("0");
    expect(cols.find((c) => c.name === "next_resume_at")?.type.toUpperCase()).toBe("TEXT");
    expect(cols.find((c) => c.name === "last_resume_from_rate_limit_at")?.type.toUpperCase()).toBe("TEXT");
  });

  it("records schema_migrations version 8 row", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version = 8").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("agent-sessions-auto-resume-backoff");
  });

  it("backfills legacy rows with rate_limit_resume_attempts=0 and NULL timestamps", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_legacy", legacyStatus: "idle" });
    // Re-open through SqliteStore — migration runs the ALTER TABLE ADD COLUMN
    // statements which apply DEFAULT 0 to the existing row.
    const store = new SqliteStore(dbPath);
    store.migrate();
    const row = store.listSessions().find((s) => s.id === "sess_legacy");
    expect(row).toBeDefined();
    expect(row?.rateLimitResumeAttempts).toBe(0);
    expect(row?.nextResumeAt).toBeNull();
    expect(row?.lastResumeFromRateLimitAt).toBeNull();
  });
});

describe("updateSessionRateLimitResume", () => {
  function freshStore(id: string) {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id, legacyStatus: "idle" });
    const store = new SqliteStore(dbPath);
    store.migrate();
    return store;
  }

  it("writes individual fields without touching the others", () => {
    const store = freshStore("sess_a");
    store.updateSessionRateLimitResume("sess_a", { rateLimitResumeAttempts: 5 });
    let row = store.listSessions().find((s) => s.id === "sess_a");
    expect(row?.rateLimitResumeAttempts).toBe(5);
    expect(row?.nextResumeAt).toBeNull();
    expect(row?.lastResumeFromRateLimitAt).toBeNull();
    store.updateSessionRateLimitResume("sess_a", { nextResumeAt: "2026-05-25T13:00:00.000Z" });
    row = store.listSessions().find((s) => s.id === "sess_a");
    expect(row?.rateLimitResumeAttempts).toBe(5); // unchanged
    expect(row?.nextResumeAt).toBe("2026-05-25T13:00:00.000Z");
  });

  it("treats null as 'write NULL' (not 'skip')", () => {
    const store = freshStore("sess_b");
    store.updateSessionRateLimitResume("sess_b", {
      rateLimitResumeAttempts: 3,
      nextResumeAt: "2026-05-25T13:00:00.000Z",
      lastResumeFromRateLimitAt: "2026-05-25T12:00:00.000Z",
    });
    store.updateSessionRateLimitResume("sess_b", { nextResumeAt: null });
    const row = store.listSessions().find((s) => s.id === "sess_b");
    expect(row?.nextResumeAt).toBeNull();
    expect(row?.rateLimitResumeAttempts).toBe(3); // unchanged
    expect(row?.lastResumeFromRateLimitAt).toBe("2026-05-25T12:00:00.000Z");
  });

  it("empty patch is a no-op (no UPDATE executed)", () => {
    const store = freshStore("sess_c");
    const before = store.listSessions().find((s) => s.id === "sess_c");
    store.updateSessionRateLimitResume("sess_c", {});
    const after = store.listSessions().find((s) => s.id === "sess_c");
    expect(after?.updatedAt).toBe(before?.updatedAt); // updated_at not touched
  });
});

describe("workspaces-pr-snapshot migration (v9)", () => {
  it("adds 7 nullable pr_* columns to workspaces", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    type PragmaRow = { name: string; type: string; notnull: number; dflt_value: string | null };
    const cols = db.prepare("PRAGMA table_info(workspaces)").all() as PragmaRow[];
    const expected: Array<[string, string]> = [
      ["pr_number", "INTEGER"],
      ["pr_state", "TEXT"],
      ["pr_last_fetch_at", "TEXT"],
      ["pr_last_checks_green_at", "TEXT"],
      ["pr_last_head_sha", "TEXT"],
      ["pr_last_head_sha_changed_at", "TEXT"],
      ["pr_last_merge_state_status", "TEXT"],
    ];
    for (const [name, type] of expected) {
      const col = cols.find((c) => c.name === name);
      expect(col, `column ${name} missing`).toBeDefined();
      expect(col?.type.toUpperCase()).toBe(type);
      expect(col?.notnull, `column ${name} should be nullable`).toBe(0);
    }
  });

  it("records schema_migrations version 9 row with name 'workspaces-pr-snapshot'", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version = 9").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("workspaces-pr-snapshot");
  });

  it("existing workspace rows survive the v9 migration with NULL snapshot columns", () => {
    const dbPath = makeTempPath();
    // Seed a workspace via the legacy helper (uses ws_test).
    seedLegacySession(dbPath, { id: "sess_legacy_v9", legacyStatus: "idle" });
    const store = new SqliteStore(dbPath);
    store.migrate();
    const snapshot = store.getWorkspacePrSnapshot("ws_test");
    expect(snapshot).toEqual({
      prNumber: null,
      prState: null,
      lastFetchAt: null,
      lastChecksGreenAt: null,
      lastHeadSha: null,
      lastHeadShaChangedAt: null,
      lastMergeStateStatus: null,
    });
  });
});

describe("updateWorkspacePrSnapshot / getWorkspacePrSnapshot", () => {
  function freshStore(): SqliteStore {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_snap", legacyStatus: "idle" });
    const store = new SqliteStore(dbPath);
    store.migrate();
    return store;
  }

  it("round-trips all 7 fields", () => {
    const store = freshStore();
    store.updateWorkspacePrSnapshot("ws_test", {
      prNumber: 42,
      prState: "open",
      lastFetchAt: "2026-05-26T20:00:00.000Z",
      lastChecksGreenAt: "2026-05-26T19:50:00.000Z",
      lastHeadSha: "abc1234",
      lastHeadShaChangedAt: "2026-05-26T19:00:00.000Z",
      lastMergeStateStatus: "CLEAN",
    });
    const snapshot = store.getWorkspacePrSnapshot("ws_test");
    expect(snapshot).toEqual({
      prNumber: 42,
      prState: "open",
      lastFetchAt: "2026-05-26T20:00:00.000Z",
      lastChecksGreenAt: "2026-05-26T19:50:00.000Z",
      lastHeadSha: "abc1234",
      lastHeadShaChangedAt: "2026-05-26T19:00:00.000Z",
      lastMergeStateStatus: "CLEAN",
    });
  });

  it("partial patch only touches named fields", () => {
    const store = freshStore();
    store.updateWorkspacePrSnapshot("ws_test", { prNumber: 7, prState: "open", lastHeadSha: "deadbee" });
    store.updateWorkspacePrSnapshot("ws_test", { prState: "merged" });
    const snapshot = store.getWorkspacePrSnapshot("ws_test");
    expect(snapshot?.prNumber).toBe(7);
    expect(snapshot?.prState).toBe("merged");
    expect(snapshot?.lastHeadSha).toBe("deadbee"); // untouched
  });

  it("explicit null clears a field (vs omission preserves)", () => {
    const store = freshStore();
    store.updateWorkspacePrSnapshot("ws_test", { lastChecksGreenAt: "2026-05-26T19:50:00.000Z" });
    store.updateWorkspacePrSnapshot("ws_test", { lastChecksGreenAt: null });
    expect(store.getWorkspacePrSnapshot("ws_test")?.lastChecksGreenAt).toBeNull();
  });

  it("getWorkspacePrSnapshot returns null for unknown workspace id", () => {
    const store = freshStore();
    expect(store.getWorkspacePrSnapshot("ws_does_not_exist")).toBeNull();
  });

  it("getWorkspacePrSnapshot rejects unexpected pr_state values via normalization", () => {
    const store = freshStore();
    const db = (store as unknown as { database: DatabaseSync }).database;
    db.exec("UPDATE workspaces SET pr_state = 'gobbledygook' WHERE id = 'ws_test'");
    expect(store.getWorkspacePrSnapshot("ws_test")?.prState).toBeNull();
  });

  it("empty patch is a no-op", () => {
    const store = freshStore();
    store.updateWorkspacePrSnapshot("ws_test", { prNumber: 1 });
    store.updateWorkspacePrSnapshot("ws_test", {});
    expect(store.getWorkspacePrSnapshot("ws_test")?.prNumber).toBe(1);
  });
});
