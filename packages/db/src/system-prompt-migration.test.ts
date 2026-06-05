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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-system-prompt-migration-"));
  dirs.push(dir);
  return path.join(dir, "citadel.sqlite");
}

function seedWorkspaceSessionBeforeSystemPromptColumns(dbPath: string) {
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
      issue_url TEXT,
      slack_thread_url TEXT,
      section TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      dirty INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
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
      terminal_backend TEXT NOT NULL DEFAULT 'tmux',
      tmux_session_name TEXT,
      tmux_session_id TEXT,
      tmux_socket_name TEXT,
      pty_session_id TEXT,
      pty_owner_socket TEXT,
      pty_owner_pid INTEGER,
      pty_last_seen_at TEXT,
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
      (21, 'workspace-sessions-terminal-backend', datetime('now')),
      (22, 'repo-main-workspace-visibility-and-checkout-title', datetime('now'));
    INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent, setup_hook_ids, teardown_hook_ids, provider_ids, created_at, updated_at, archived_at)
    VALUES ('repo_existing', 'r', '/tmp/existing-r', 'main', 'origin', '/tmp/existing-w', '[]', '[]', '[]', '${now}', '${now}', NULL);
    INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url, issue_key, issue_title, issue_url, slack_thread_url, section, pinned, lifecycle, dirty, created_at, updated_at, archived_at)
    VALUES ('ws_existing', 'repo_existing', 'ws', '/tmp/existing-ws', 'main', 'main', 'scratch', 'worktree', NULL, NULL, NULL, NULL, NULL, 'backlog', 0, 'ready', 0, '${now}', '${now}', NULL);
    INSERT INTO workspace_sessions (id, workspace_id, kind, runtime_id, display_name, status, status_reason,
      status_reason_at, last_status_at, last_output_at, ended_at, exit_code, transport, terminal_backend,
      tmux_session_name, tmux_session_id, tmux_socket_name, tab_id, runtime_session_id, rate_limit_resume_attempts,
      next_resume_at, last_resume_from_rate_limit_at, created_at, updated_at)
    VALUES ('sess_existing', 'ws_existing', 'agent', 'claude-code', 'test', 'running', NULL,
      NULL, '${now}', NULL, NULL, NULL, 'disconnected', 'tmux',
      'citadel_existing', '$1', NULL, 'sess_existing', NULL, 0, NULL, NULL, '${now}', '${now}');
  `);
  store.close();
}

describe("workspace session system prompt migration (version 23)", () => {
  it("adds nullable system prompt metadata columns to workspace_sessions and records the migration row", () => {
    const store = new SqliteStore(makeTempPath());
    store.migrate();
    const db = (store as unknown as { database: DatabaseSync }).database;
    const cols = db.prepare("PRAGMA table_info(workspace_sessions)").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const byName = new Map(cols.map((column) => [column.name, column]));

    for (const name of [
      "system_prompt_snapshot",
      "system_prompt_sources",
      "system_prompt_delivery",
      "system_prompt_last_delivery",
    ]) {
      expect(byName.get(name), `column ${name} missing`).toMatchObject({ type: "TEXT", notnull: 0 });
    }

    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 23").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("workspace-session-system-prompts");
  });

  it("leaves existing rows with nullable system prompt metadata", () => {
    const dbPath = makeTempPath();
    seedWorkspaceSessionBeforeSystemPromptColumns(dbPath);

    const store = new SqliteStore(dbPath);
    store.migrate();
    const row = store.listSessions().find((session) => session.id === "sess_existing");

    expect(row?.systemPromptSources).toBeNull();
    expect(row?.systemPromptDelivery).toBeNull();
    expect(row?.systemPromptLastDelivery).toBeNull();
    expect(
      store
        .query(
          `SELECT system_prompt_snapshot, system_prompt_sources, system_prompt_delivery, system_prompt_last_delivery
           FROM workspace_sessions
           WHERE id = 'sess_existing'`,
        )
        .at(0),
    ).toEqual({
      system_prompt_snapshot: null,
      system_prompt_sources: null,
      system_prompt_delivery: null,
      system_prompt_last_delivery: null,
    });
  });
});
