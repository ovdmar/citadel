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

function makeTempPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-migration-"));
  dirs.push(dir);
  return path.join(dir, "citadel.sqlite");
}

type LegacySessionOptions = {
  id: string;
  legacyStatus: "waiting" | "orphaned" | "idle" | "running";
  runtimeId?: string;
  lastStatusAt?: string;
  updatedAt?: string;
  tmuxSocketName?: string | null;
};

// Sets up a pre-workspace_sessions database with an agent_sessions row, then
// re-opens it through SqliteStore so the migration runs against real legacy
// state. The data-backfill UPDATE statements are idempotent — they'll run
// every boot, but only touch matching rows.
function seedLegacySession(dbPath: string, opts: LegacySessionOptions) {
  const store = new SqliteStore(dbPath);
  const db = (store as unknown as { database: DatabaseSync }).database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      default_remote TEXT NOT NULL,
      worktree_parent TEXT NOT NULL,
      setup_hook_ids TEXT NOT NULL,
      teardown_hook_ids TEXT NOT NULL,
      provider_ids TEXT NOT NULL,
      deploy_hook_command TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'worktree',
      pr_url TEXT,
      issue_key TEXT,
      issue_title TEXT,
      issue_url TEXT,
      slack_thread_url TEXT,
      section TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      dirty INTEGER NOT NULL,
      namespace_id TEXT,
      auto_recovery_last_ci_sha TEXT,
      auto_recovery_last_attempt_at TEXT,
      pr_number INTEGER,
      pr_state TEXT,
      pr_last_fetch_at TEXT,
      pr_last_checks_green_at TEXT,
      pr_last_head_sha TEXT,
      pr_last_head_sha_changed_at TEXT,
      pr_last_merge_state_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(repo_id, name)
    );
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      runtime_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      status_reason_at TEXT,
      last_status_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      last_output_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      transport TEXT NOT NULL,
      tmux_session_name TEXT,
      tmux_session_id TEXT,
      tmux_socket_name TEXT,
      tab_id TEXT,
      runtime_session_id TEXT,
      rate_limit_resume_attempts INTEGER NOT NULL DEFAULT 0,
      next_resume_at TEXT,
      last_resume_from_rate_limit_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const lastStatusAt = opts.lastStatusAt ?? "2026-05-17T00:00:00.000Z";
  const updatedAt = opts.updatedAt ?? "2026-05-17T00:00:00.000Z";
  db.exec(`INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent, setup_hook_ids, teardown_hook_ids, provider_ids, deploy_hook_command, created_at, updated_at, archived_at)
    VALUES ('repo_test', 'r', '/tmp/r', 'main', 'origin', '/tmp/w', '[]', '[]', '[]', NULL, '${new Date().toISOString()}', '${new Date().toISOString()}', NULL)
    ON CONFLICT(id) DO NOTHING`);
  db.exec(`INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url, issue_key, issue_title, issue_url, slack_thread_url, section, pinned, lifecycle, dirty, namespace_id, created_at, updated_at, archived_at)
    VALUES ('ws_test', 'repo_test', 'ws', '/tmp/ws', 'main', 'main', 'scratch', 'worktree', NULL, NULL, NULL, NULL, NULL, 'backlog', 0, 'ready', 0, NULL, '${now}', '${now}', NULL)
    ON CONFLICT(id) DO NOTHING`);
  db.prepare(
    `INSERT INTO agent_sessions (id, workspace_id, runtime_id, display_name, status, status_reason,
      status_reason_at, last_status_at, last_output_at, ended_at, exit_code, transport, tmux_session_name,
      tmux_session_id, tmux_socket_name, tab_id, runtime_session_id, rate_limit_resume_attempts, next_resume_at,
      last_resume_from_rate_limit_at, created_at, updated_at)
     VALUES (?, 'ws_test', ?, 'test', ?, NULL, NULL, ?, NULL, NULL, NULL, 'disconnected', 'citadel_test',
      '$1', ?, ?, NULL, 0, NULL, NULL, '2026-05-17T00:00:00.000Z', ?)`,
  ).run(
    opts.id,
    opts.runtimeId ?? "claude-code",
    opts.legacyStatus,
    lastStatusAt,
    opts.tmuxSocketName ?? null,
    opts.id,
    updatedAt,
  );
  store.close();
}

function seedWorkspaceSessionWithoutTmuxSocket(dbPath: string) {
  const store = new SqliteStore(dbPath);
  const db = (store as unknown as { database: DatabaseSync }).database;
  const now = "2026-05-31T19:07:00.000Z";
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repos (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      default_branch TEXT NOT NULL,
      default_remote TEXT NOT NULL,
      worktree_parent TEXT NOT NULL,
      setup_hook_ids TEXT NOT NULL,
      teardown_hook_ids TEXT NOT NULL,
      provider_ids TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL REFERENCES repos(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      source TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'worktree',
      pr_url TEXT,
      issue_key TEXT,
      issue_title TEXT,
      section TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      dirty INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(repo_id, name)
    );
    CREATE TABLE IF NOT EXISTS workspace_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      kind TEXT NOT NULL DEFAULT 'agent',
      runtime_id TEXT,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      status_reason_at TEXT,
      last_status_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      last_output_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      transport TEXT NOT NULL,
      tmux_session_name TEXT,
      tmux_session_id TEXT,
      tab_id TEXT,
      runtime_session_id TEXT,
      rate_limit_resume_attempts INTEGER NOT NULL DEFAULT 0,
      next_resume_at TEXT,
      last_resume_from_rate_limit_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (kind = 'agent' AND runtime_id IS NOT NULL)
        OR (kind = 'terminal' AND runtime_id IS NULL)
      )
    );
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (13, 'agent-sessions-tmux-socket-name', datetime('now')),
      (14, 'agent-sessions-backfill-workspace-tmux-sockets', datetime('now'));
    INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent, setup_hook_ids, teardown_hook_ids, provider_ids, created_at, updated_at, archived_at)
    VALUES ('repo_existing', 'r', '/tmp/existing-r', 'main', 'origin', '/tmp/existing-w', '[]', '[]', '[]', '${now}', '${now}', NULL);
    INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url, issue_key, issue_title, section, pinned, lifecycle, dirty, created_at, updated_at, archived_at)
    VALUES ('ws_existing', 'repo_existing', 'ws', '/tmp/existing-ws', 'main', 'main', 'scratch', 'worktree', NULL, NULL, NULL, 'backlog', 0, 'ready', 0, '${now}', '${now}', NULL);
    INSERT INTO workspace_sessions (id, workspace_id, kind, runtime_id, display_name, status, status_reason,
      status_reason_at, last_status_at, last_output_at, ended_at, exit_code, transport, tmux_session_name,
      tmux_session_id, tab_id, runtime_session_id, rate_limit_resume_attempts, next_resume_at,
      last_resume_from_rate_limit_at, created_at, updated_at)
    VALUES ('sess_existing', 'ws_existing', 'agent', 'claude-code', 'test', 'running', NULL,
      NULL, '${now}', NULL, NULL, NULL, 'disconnected', 'citadel_existing',
      '$1', 'sess_existing', NULL, 0, NULL, NULL, '${now}', '${now}');
  `);
  store.close();
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
    seedLegacySession(dbPath, {
      id: "sess_pre",
      legacyStatus: "running",
      lastStatusAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "2026-05-20T14:30:00.000Z",
    });
    const store = new SqliteStore(dbPath);
    store.migrate();
    const row = store.listSessions().find((s) => s.id === "sess_pre");
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
    const cols = db.prepare("PRAGMA table_info(workspace_sessions)").all() as Array<{
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

describe("tmux socket migration (version 13)", () => {
  it("adds nullable tmux_socket_name to workspace_sessions", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const cols = db.prepare("PRAGMA table_info(workspace_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const column = cols.find((c) => c.name === "tmux_socket_name");
    expect(column).toBeDefined();
    expect(column?.type.toUpperCase()).toBe("TEXT");
    expect(column?.notnull).toBe(0);
  });

  it("records schema_migrations version 13 row", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const row = db.prepare("SELECT name FROM schema_migrations WHERE version = 13").get() as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("agent-sessions-tmux-socket-name");
  });

  it("backfills legacy rows to their workspace tmux socket on the next migration pass", () => {
    const previous = process.env.CITADEL_TMUX_SOCKET;
    process.env.CITADEL_TMUX_SOCKET = "citadel-test";
    try {
      const dbPath = makeTempPath();
      seedLegacySession(dbPath, { id: "sess_backfill", legacyStatus: "idle" });

      const store = new SqliteStore(dbPath);
      store.migrate();

      const row = store.listSessions().find((s) => s.id === "sess_backfill");
      expect(row?.tmuxSocketName).toBe("citadel-test-ws-ws_test");
      const db = (store as unknown as { database: DatabaseSync }).database;
      const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 14").get() as
        | { name: string }
        | undefined;
      expect(migration?.name).toBe("agent-sessions-backfill-workspace-tmux-sockets");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "CITADEL_TMUX_SOCKET");
      else process.env.CITADEL_TMUX_SOCKET = previous;
    }
  });

  it("does not overwrite rows that already have an explicit tmux socket", () => {
    const previous = process.env.CITADEL_TMUX_SOCKET;
    process.env.CITADEL_TMUX_SOCKET = "citadel-new";
    try {
      const dbPath = makeTempPath();
      seedLegacySession(dbPath, { id: "sess_socket_keep", legacyStatus: "idle" });
      const seeded = new SqliteStore(dbPath);
      seeded.migrate();
      const db = (seeded as unknown as { database: DatabaseSync }).database;
      db.prepare("UPDATE workspace_sessions SET tmux_socket_name = ? WHERE id = ?").run(
        "manual-socket",
        "sess_socket_keep",
      );

      const migrated = new SqliteStore(dbPath);
      migrated.migrate();
      const row = migrated.listSessions().find((s) => s.id === "sess_socket_keep");
      expect(row?.tmuxSocketName).toBe("manual-socket");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "CITADEL_TMUX_SOCKET");
      else process.env.CITADEL_TMUX_SOCKET = previous;
    }
  });
});

describe("terminal backend migration (version 20)", () => {
  it("adds terminal backend and nullable PTY owner columns to workspace_sessions", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const cols = db.prepare("PRAGMA table_info(workspace_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const byName = new Map(cols.map((column) => [column.name, column]));

    expect(byName.get("terminal_backend")).toMatchObject({
      type: "TEXT",
      notnull: 1,
      dflt_value: "'tmux'",
    });
    expect(byName.get("pty_session_id")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(byName.get("pty_owner_socket")).toMatchObject({ type: "TEXT", notnull: 0 });
    expect(byName.get("pty_owner_pid")).toMatchObject({ type: "INTEGER", notnull: 0 });
    expect(byName.get("pty_last_seen_at")).toMatchObject({ type: "TEXT", notnull: 0 });

    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 20").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("workspace-sessions-terminal-backend");
  });
});

describe("workspace_sessions migration (version 15)", () => {
  it("moves legacy agent_sessions rows into workspace_sessions and drops the old table", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_agent", legacyStatus: "idle" });

    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;

    const legacyTable = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_sessions'")
      .get();
    expect(legacyTable).toBeUndefined();
    expect(db.prepare("SELECT kind, runtime_id FROM workspace_sessions WHERE id = ?").get("sess_agent")).toEqual({
      kind: "agent",
      runtime_id: "claude-code",
    });
    expect(store.listSessions().find((s) => s.id === "sess_agent")?.runtimeId).toBe("claude-code");
    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 15").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("workspace-sessions-agent-terminal-split");
  });

  it("converts legacy shell runtime rows into terminal workspace sessions", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_terminal", legacyStatus: "running", runtimeId: "shell" });

    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;

    expect(db.prepare("SELECT kind, runtime_id FROM workspace_sessions WHERE id = ?").get("sess_terminal")).toEqual({
      kind: "terminal",
      runtime_id: null,
    });
    expect(store.listSessions().find((s) => s.id === "sess_terminal")).toBeUndefined();
    expect(store.listWorkspaceSessions().find((s) => s.id === "sess_terminal")).toMatchObject({
      kind: "terminal",
      runtimeId: null,
    });
  });

  it("repairs already-migrated workspace_sessions schemas that are missing tmux_socket_name", () => {
    const previous = process.env.CITADEL_TMUX_SOCKET;
    process.env.CITADEL_TMUX_SOCKET = "citadel-existing";
    try {
      const dbPath = makeTempPath();
      seedWorkspaceSessionWithoutTmuxSocket(dbPath);

      const store = new SqliteStore(dbPath);
      store.migrate();
      const db = (store as unknown as { database: DatabaseSync }).database;

      const cols = db.prepare("PRAGMA table_info(workspace_sessions)").all() as Array<{ name: string }>;
      expect(cols.some((c) => c.name === "tmux_socket_name")).toBe(true);
      expect(store.listSessions().find((s) => s.id === "sess_existing")?.tmuxSocketName).toBe(
        "citadel-existing-ws-ws_existing",
      );
      const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 15").get() as
        | { name: string }
        | undefined;
      expect(migration?.name).toBe("workspace-sessions-agent-terminal-split");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "CITADEL_TMUX_SOCKET");
      else process.env.CITADEL_TMUX_SOCKET = previous;
    }
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

describe("workspace home/checkouts/manager migration (v16)", () => {
  it("relaxes workspaces.repo_id and adds structured workspace tables", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const workspaceCols = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{
      name: string;
      notnull: number;
    }>;

    expect(workspaceCols.find((c) => c.name === "repo_id")?.notnull).toBe(0);
    for (const column of ["root_path", "mode", "lifecycle_phase", "parent_issue_key"]) {
      expect(
        workspaceCols.some((c) => c.name === column),
        `missing ${column}`,
      ).toBe(true);
    }
    for (const table of [
      "workspace_checkouts",
      "workspace_plan_versions",
      "workspace_plan_reviews",
      "workspace_plan_decisions",
      "workspace_managers",
      "manager_events",
      "plan_deviation_reports",
      "checkout_review_artifacts",
    ]) {
      const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
        | { name: string }
        | undefined;
      expect(row?.name).toBe(table);
    }
    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 16").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("workspace-home-checkouts-manager");
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("backfills one checkout for existing worktree workspaces", () => {
    const dbPath = makeTempPath();
    seedLegacySession(dbPath, { id: "sess_checkout_backfill", legacyStatus: "idle" });
    const store = new SqliteStore(dbPath);
    store.migrate();

    expect(store.listWorkspaces().find((workspace) => workspace.id === "ws_test")).toMatchObject({
      rootPath: "/tmp/ws",
      mode: "freestyle",
      parentIssue: undefined,
    });
    expect(store.listWorkspaceCheckouts("ws_test")).toMatchObject([
      {
        id: "checkout_ws_test",
        repoId: "repo_test",
        path: "/tmp/ws",
        branch: "main",
        gateStatus: "not_started",
      },
    ]);
  });

  it("records checkout issue and PR gate fact migration columns", () => {
    const dbPath = makeTempPath();
    const store = new SqliteStore(dbPath);
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const checkoutCols = db.prepare("PRAGMA table_info(workspace_checkouts)").all() as Array<{ name: string }>;
    for (const column of [
      "issue_title",
      "issue_status",
      "issue_fetched_at",
      "intended_pr_fetched_at",
      "intended_pr_checks_green",
      "intended_pr_merge_state_status",
      "intended_pr_has_conflicts",
    ]) {
      expect(
        checkoutCols.some((entry) => entry.name === column),
        `missing ${column}`,
      ).toBe(true);
    }
    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 17").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("workspace-checkout-issue-status");
    const prMigration = db.prepare("SELECT name FROM schema_migrations WHERE version = 18").get() as
      | { name: string }
      | undefined;
    expect(prMigration?.name).toBe("checkout-pr-gate-facts");
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
