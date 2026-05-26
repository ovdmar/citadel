// All SQLite schema creation + additive migrations. Extracted from
// SqliteStore so that index.ts stays under the 800-line file-size gate.
//
// Migrations are idempotent (CREATE TABLE IF NOT EXISTS / ensureColumn /
// WHERE-clause-gated UPDATEs). Re-running migrate() on a fully-migrated DB
// is a no-op.

type SqliteDatabase = {
  exec(sql: string): void;
};

export function runMigrations(
  db: SqliteDatabase,
  ensureColumn: (table: string, column: string, definition: string) => void,
) {
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
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id),
      runtime_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL,
      status_reason TEXT,
      last_status_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      last_output_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      transport TEXT NOT NULL,
      tmux_session_name TEXT,
      tmux_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      repo_id TEXT,
      workspace_id TEXT,
      progress INTEGER NOT NULL,
      message TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      repo_id TEXT,
      workspace_id TEXT,
      operation_id TEXT,
      message TEXT NOT NULL,
      hook_output TEXT,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
    VALUES (1, 'initial-local-first-schema', datetime('now'));
  `);
  ensureColumn("activity_events", "hook_output", "TEXT");
  ensureColumn("operations", "logs", "TEXT");
  ensureColumn("operations", "retriable", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("operations", "retry_input", "TEXT");
  ensureColumn("workspaces", "issue_url", "TEXT");
  ensureColumn("workspaces", "slack_thread_url", "TEXT");
  ensureColumn("workspaces", "kind", "TEXT NOT NULL DEFAULT 'worktree'");
  ensureColumn("repos", "deploy_hook_command", "TEXT");
  // Agent-status migration (canonical enum + tracking fields). All additive;
  // status remaps are idempotent. Wrapped in a transaction so a crash mid-
  // migration leaves rows untouched. See specs/B.3 for canonical values.
  ensureColumn("agent_sessions", "status_reason", "TEXT");
  ensureColumn("agent_sessions", "last_status_at", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  ensureColumn("agent_sessions", "last_output_at", "TEXT");
  ensureColumn("agent_sessions", "ended_at", "TEXT");
  ensureColumn("agent_sessions", "exit_code", "INTEGER");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("UPDATE agent_sessions SET last_status_at = updated_at WHERE last_status_at = '1970-01-01T00:00:00.000Z'");
    db.exec(
      "UPDATE agent_sessions SET status = 'running', status_reason = 'migrated_from_waiting' WHERE status = 'waiting'",
    );
    db.exec(
      "UPDATE agent_sessions SET status = 'unknown', status_reason = 'migrated_from_orphaned' WHERE status = 'orphaned'",
    );
    db.exec(
      "UPDATE agent_sessions SET status_reason = 'migrated_legacy_idle' WHERE status = 'idle' AND status_reason IS NULL",
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS namespaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      color TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
  `);
  ensureColumn("workspaces", "namespace_id", "TEXT REFERENCES namespaces(id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      cron TEXT NOT NULL,
      repo_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL,
      prompt TEXT,
      workspace_strategy TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      base_branch TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      last_run_status TEXT NOT NULL DEFAULT 'never',
      last_run_message TEXT,
      last_workspace_id TEXT,
      last_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_agent_runs (
      id TEXT PRIMARY KEY,
      scheduled_agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      enqueued_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      message TEXT,
      workspace_id TEXT,
      session_id TEXT,
      background_session_id TEXT,
      log_file_path TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_agent_runs_agent_enqueued
      ON scheduled_agent_runs(scheduled_agent_id, enqueued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_agent_runs_status
      ON scheduled_agent_runs(scheduled_agent_id, status);
    CREATE TABLE IF NOT EXISTS background_sessions (
      id TEXT PRIMARY KEY,
      scheduled_agent_id TEXT,
      cwd TEXT NOT NULL,
      log_file_path TEXT NOT NULL,
      tmux_session_name TEXT NOT NULL,
      tmux_session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_background_sessions_scheduled_agent
      ON background_sessions(scheduled_agent_id);
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (2, 'activity-hook-output', datetime('now')),
      (3, 'operation-logs-retry', datetime('now')),
      (4, 'workspace-linked-urls', datetime('now')),
      (5, 'scheduled-agents', datetime('now')),
      (6, 'namespaces', datetime('now')),
      (7, 'background-sessions-and-runs', datetime('now'));
  `);
  ensureColumn("scheduled_agents", "schedule_type", "TEXT NOT NULL DEFAULT 'recurring'");
  ensureColumn("scheduled_agents", "run_at", "TEXT");
  ensureColumn("scheduled_agents", "run_mode", "TEXT NOT NULL DEFAULT 'workspace'");
  ensureColumn("scheduled_agents", "background_cwd", "TEXT");
  ensureColumn("scheduled_agents", "overlap_policy", "TEXT NOT NULL DEFAULT 'skip'");
  // Per-SHA dedupe + debounce state for the CI auto-recovery tick. Both are
  // nullable; "never auto-recovered" reads as both NULL. Additive columns
  // follow the trailing-ensureColumn convention (no new schema_migrations
  // row required — they ride the latest baseline version).
  ensureColumn("workspaces", "auto_recovery_last_ci_sha", "TEXT");
  ensureColumn("workspaces", "auto_recovery_last_attempt_at", "TEXT");
  // Runtime-native session UUID captured at spawn time (claude-code's
  // --session-id, codex's thread_id, etc.). Nullable for legacy rows and for
  // runtimes without a session ID. Read on respawn to pass --resume so the
  // conversation survives daemon/machine restarts.
  ensureColumn("agent_sessions", "runtime_session_id", "TEXT");
  // Auto-resume bookkeeping. attempts counts consecutive auto-resume sends
  // (for exponential backoff); next_resume_at is the scheduled time of the
  // next attempt (NULL = unscheduled); last_resume_from_rate_limit_at is the
  // wall clock of the most recent send. See packages/operations/auto-resume.
  ensureColumn("agent_sessions", "rate_limit_resume_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("agent_sessions", "next_resume_at", "TEXT");
  ensureColumn("agent_sessions", "last_resume_from_rate_limit_at", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (8, 'agent-sessions-auto-resume-backoff', datetime('now'));
  `);
}
