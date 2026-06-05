import process from "node:process";
import { migrateInternalReviewThreads } from "./internal-review-migration.js";
import { migrateManagerOrchestrationLedger } from "./manager-orchestration-migration.js";
import { migrateWorkspaceHomeCheckoutsManager } from "./workspace-structure-migration.js";

// All SQLite schema creation + additive migrations. Extracted from
// SqliteStore so that index.ts stays under the 800-line file-size gate.
//
// Migrations are idempotent (CREATE TABLE IF NOT EXISTS / ensureColumn /
// WHERE-clause-gated UPDATEs). Re-running migrate() on a fully-migrated DB
// is a no-op.

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
};

type SessionTableName = "agent_sessions" | "workspace_sessions";

// Highest schema_migrations version known to this code path. Bump alongside
// the corresponding `INSERT OR IGNORE INTO schema_migrations` that introduces
// the new version below. Consumed by the doctor's database-schema check so
// `make doctor` can flag an installed daemon whose code is newer than the
// database it's been given.
export const CURRENT_SCHEMA_VERSION = 23;

function tmuxSocketBase(): string {
  const configured = process.env.CITADEL_TMUX_SOCKET?.trim();
  return configured && configured.length > 0 ? configured : "citadel";
}

function tmuxSocketNameForWorkspaceId(workspaceId: string): string {
  const safeWorkspaceId = workspaceId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${tmuxSocketBase()}-ws-${safeWorkspaceId}`;
}

function backfillWorkspaceTmuxSocketNames(db: SqliteDatabase, tableName: SessionTableName): void {
  const rows = db
    .prepare(`
      SELECT s.id AS session_id, s.workspace_id AS workspace_id
      FROM ${tableName} s
      JOIN workspaces w ON w.id = s.workspace_id
      WHERE s.tmux_socket_name IS NULL OR s.tmux_socket_name = ''
    `)
    .all() as Array<{ session_id: string; workspace_id: string }>;

  db.exec("BEGIN");
  try {
    const update = db.prepare(`
      UPDATE ${tableName}
      SET tmux_socket_name = ?
      WHERE id = ? AND (tmux_socket_name IS NULL OR tmux_socket_name = '')
    `);
    for (const row of rows) {
      update.run(tmuxSocketNameForWorkspaceId(row.workspace_id), row.session_id);
    }
    db.exec(`
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
        (14, 'agent-sessions-backfill-workspace-tmux-sockets', datetime('now'));
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function backfillNamespacePositions(db: SqliteDatabase): void {
  const summary = db
    .prepare("SELECT COUNT(*) AS total, COUNT(DISTINCT position) AS distinct_positions FROM namespaces")
    .get() as { total: number; distinct_positions: number } | undefined;
  if (!summary || summary.total <= 1 || summary.distinct_positions > 1) return;
  const rows = db.prepare("SELECT id FROM namespaces ORDER BY name").all() as Array<{ id: string }>;
  const update = db.prepare("UPDATE namespaces SET position = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const [index, row] of rows.entries()) update.run((index + 1) * 1024, row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function runMigrations(
  db: SqliteDatabase,
  ensureColumn: (table: string, column: string, definition: string) => void,
) {
  const hasLegacyAgentSessions = tableExists(db, "agent_sessions");
  const hasWorkspaceSessions = tableExists(db, "workspace_sessions");
  const sessionBaselineTableSql =
    hasLegacyAgentSessions && !hasWorkspaceSessions ? legacyAgentSessionsTableSql() : workspaceSessionsTableSql();
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
    ${sessionBaselineTableSql}
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
  ensureColumn("repos", "provider_repository_key", "TEXT");
  ensureColumn("repos", "show_main_workspace", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("operations", "logs", "TEXT");
  ensureColumn("operations", "retriable", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("operations", "retry_input", "TEXT");
  ensureColumn("workspaces", "issue_url", "TEXT");
  ensureColumn("workspaces", "slack_thread_url", "TEXT");
  ensureColumn("workspaces", "kind", "TEXT NOT NULL DEFAULT 'worktree'");
  ensureColumn("repos", "deploy_hook_command", "TEXT");
  const sessionTable = sessionTableForMigrations(db);
  if (sessionTable === "workspace_sessions") ensureColumn(sessionTable, "kind", "TEXT NOT NULL DEFAULT 'agent'");
  // Agent-status migration (canonical enum + tracking fields). All additive;
  // status remaps are idempotent. Wrapped in a transaction so a crash mid-
  // migration leaves rows untouched. See specs/B.3 for canonical values.
  ensureColumn(sessionTable, "status_reason", "TEXT");
  ensureColumn(sessionTable, "last_status_at", "TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
  ensureColumn(sessionTable, "last_output_at", "TEXT");
  ensureColumn(sessionTable, "ended_at", "TEXT");
  ensureColumn(sessionTable, "exit_code", "INTEGER");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`UPDATE ${sessionTable} SET last_status_at = updated_at WHERE last_status_at = '1970-01-01T00:00:00.000Z'`);
    db.exec(
      `UPDATE ${sessionTable} SET status = 'running', status_reason = 'migrated_from_waiting' WHERE status = 'waiting'`,
    );
    db.exec(
      `UPDATE ${sessionTable} SET status = 'unknown', status_reason = 'migrated_from_orphaned' WHERE status = 'orphaned'`,
    );
    db.exec(
      `UPDATE ${sessionTable} SET status_reason = 'migrated_legacy_idle' WHERE status = 'idle' AND status_reason IS NULL`,
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
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
  `);
  ensureColumn("namespaces", "position", "INTEGER NOT NULL DEFAULT 0");
  backfillNamespacePositions(db);
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
  ensureColumn(sessionTable, "runtime_session_id", "TEXT");
  // Auto-resume bookkeeping. attempts counts consecutive auto-resume sends
  // (for exponential backoff); next_resume_at is the scheduled time of the
  // next attempt (NULL = unscheduled); last_resume_from_rate_limit_at is the
  // wall clock of the most recent send. See packages/operations/auto-resume.
  ensureColumn(sessionTable, "rate_limit_resume_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(sessionTable, "next_resume_at", "TEXT");
  ensureColumn(sessionTable, "last_resume_from_rate_limit_at", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (8, 'agent-sessions-auto-resume-backoff', datetime('now'));
  `);
  // Per-workspace PR snapshot. Survives daemon restart so the gh-scheduler can
  // hydrate cadence state (especially merged → never-poll) without burning a
  // boot-time gh call per workspace. All columns nullable; existing rows read
  // NULL → scheduler treats as "never fetched, eligible now". Versioned via
  // schema_migrations so downstream tooling/tests can assert on the row.
  ensureColumn("workspaces", "pr_number", "INTEGER");
  ensureColumn("workspaces", "pr_state", "TEXT"); // 'open' | 'closed' | 'merged'
  ensureColumn("workspaces", "pr_last_fetch_at", "TEXT");
  ensureColumn("workspaces", "pr_last_checks_green_at", "TEXT");
  ensureColumn("workspaces", "pr_last_head_sha", "TEXT");
  ensureColumn("workspaces", "pr_last_head_sha_changed_at", "TEXT");
  ensureColumn("workspaces", "pr_last_merge_state_status", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (9, 'workspaces-pr-snapshot', datetime('now'));
  `);

  // status_reason_at: ISO timestamp of when status_reason was last written.
  // Drives the 30-min auto-clear of `idle_after_unexpected_exit` (shell-first
  // pane lifecycle) independent of last_status_at — the latter is reset by
  // every benign sub-status flip from runtime adapters and is therefore not
  // a reliable clock for the auto-clear. Additive nullable column; existing
  // rows get NULL.
  ensureColumn(sessionTable, "status_reason_at", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (10, 'agent-sessions-status-reason-at', datetime('now'));
  `);

  // tab_id: stable per-tab identifier. New sessions get a fresh time-encoded
  // id; restored sessions inherit their source row's tab_id so the cockpit's
  // tab strip puts the restored conversation back in its original slot
  // instead of appending it to the end of the row. Backfill existing rows
  // with their own primary id — that keeps current ordering identical since
  // both id and tab_id are time-encoded with the same generator. Wrapped in
  // a transaction so a crash mid-migration leaves rows untouched.
  ensureColumn(sessionTable, "tab_id", "TEXT");
  db.exec(`
    BEGIN;
    UPDATE ${sessionTable} SET tab_id = id WHERE tab_id IS NULL OR tab_id = '';
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (11, 'agent-sessions-tab-id', datetime('now'));
    COMMIT;
  `);

  // One-shot dedup for accumulated restore artifacts: prior to the source-
  // row cleanup landing in restore-routes / boot-restore, every successful
  // restore left the original row in the DB. Repeated restarts produced
  // 7-8 rows per (workspace, runtime_session_id), and the cockpit's tab
  // strip rendered one tab per row. Keep only the most recently created
  // row in each group; the older ones are dead pointers (their tmux died
  // when the previous tmux server was killed, the only reason they look
  // "running" is the cockpit's terminal-attach respawned an empty pane
  // under the same name). The orphan-reaper will pick up those zombie
  // tmux sessions on its next sweep. Idempotent and safe to run on an
  // already-deduped DB.
  // Self-join: delete any row that has a strictly newer sibling with the
  // same (workspace_id, runtime_session_id). Single-row groups produce no
  // join matches → untouched. Multi-row groups collapse to the latest by
  // created_at. Works on every SQLite version (no window-function dep).
  db.exec(`
    BEGIN;
    DELETE FROM ${sessionTable}
    WHERE rowid IN (
      SELECT a.rowid
      FROM ${sessionTable} a
      JOIN ${sessionTable} b
        ON a.workspace_id = b.workspace_id
       AND a.runtime_session_id = b.runtime_session_id
       AND b.created_at > a.created_at
      WHERE a.runtime_session_id IS NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (12, 'agent-sessions-dedup-restore-cruft', datetime('now'));
    COMMIT;
  `);

  // tmux_socket_name shards agent panes across tmux servers. v13 added the
  // column; v14 backfills legacy rows onto the same workspace-specific socket
  // formula used for new session spawns. Current live panes may still be bound
  // to the old shared socket until the operator relaunches/restores them.
  ensureColumn(sessionTable, "tmux_socket_name", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (13, 'agent-sessions-tmux-socket-name', datetime('now'));
  `);
  backfillWorkspaceTmuxSocketNames(db, sessionTable);
  migrateWorkspaceSessions(db);
  ensureColumn("workspace_sessions", "tmux_socket_name", "TEXT");
  backfillWorkspaceTmuxSocketNames(db, "workspace_sessions");
  migrateWorkspaceHomeCheckoutsManager(db, ensureColumn);
  ensureColumn("workspace_checkouts", "issue_title", "TEXT");
  ensureColumn("workspace_checkouts", "display_name", "TEXT");
  ensureColumn("workspace_checkouts", "issue_status", "TEXT");
  ensureColumn("workspace_checkouts", "issue_fetched_at", "TEXT");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (17, 'workspace-checkout-issue-status', datetime('now'));
  `);
  ensureColumn("workspace_checkouts", "intended_pr_fetched_at", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_state", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_checks_green", "INTEGER");
  ensureColumn("workspace_checkouts", "intended_pr_merge_state_status", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_has_conflicts", "INTEGER");
  db.exec(`
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (18, 'checkout-pr-gate-facts', datetime('now'));
  `);
  migrateManagerOrchestrationLedger(db, ensureColumn);
  migrateInternalReviewThreads(db);
  ensureColumn("workspace_sessions", "terminal_backend", "TEXT NOT NULL DEFAULT 'tmux'");
  ensureColumn("workspace_sessions", "pty_session_id", "TEXT");
  ensureColumn("workspace_sessions", "pty_owner_socket", "TEXT");
  ensureColumn("workspace_sessions", "pty_owner_pid", "INTEGER");
  ensureColumn("workspace_sessions", "pty_last_seen_at", "TEXT");
  ensureColumn("workspace_sessions", "system_prompt_snapshot", "TEXT");
  ensureColumn("workspace_sessions", "system_prompt_sources", "TEXT");
  ensureColumn("workspace_sessions", "system_prompt_delivery", "TEXT");
  ensureColumn("workspace_sessions", "system_prompt_last_delivery", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workspace_sessions_pty_session ON workspace_sessions(pty_session_id);
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (21, 'workspace-sessions-terminal-backend', datetime('now')),
      (22, 'repo-main-workspace-visibility-and-checkout-title', datetime('now')),
      (23, 'workspace-session-system-prompts', datetime('now'));
  `);
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row?.name === tableName;
}

function sessionTableForMigrations(db: SqliteDatabase): SessionTableName {
  return tableExists(db, "agent_sessions") && !tableExists(db, "workspace_sessions")
    ? "agent_sessions"
    : "workspace_sessions";
}

function legacyAgentSessionsTableSql() {
  return `
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
    );`;
}

function workspaceSessionsTableSql() {
  return `
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
      system_prompt_snapshot TEXT,
      system_prompt_sources TEXT,
      system_prompt_delivery TEXT,
      system_prompt_last_delivery TEXT,
      rate_limit_resume_attempts INTEGER NOT NULL DEFAULT 0,
      next_resume_at TEXT,
      last_resume_from_rate_limit_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (kind = 'agent' AND runtime_id IS NOT NULL)
        OR (kind = 'terminal' AND runtime_id IS NULL)
      )
    );`;
}

function migrateWorkspaceSessions(db: SqliteDatabase) {
  const hasLegacyAgentSessions = tableExists(db, "agent_sessions");
  if (!hasLegacyAgentSessions) {
    finalizeWorkspaceSessionsMigration(db);
    return;
  }
  assertExpectedAgentSessionDependencies(db);
  if (tableExists(db, "workspace_sessions")) {
    mergeAgentSessionsIntoWorkspaceSessions(db);
  } else {
    renameAgentSessionsToWorkspaceSessions(db);
  }
  finalizeWorkspaceSessionsMigration(db);
}

function finalizeWorkspaceSessionsMigration(db: SqliteDatabase) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_workspace_sessions_workspace ON workspace_sessions(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_sessions_runtime_session ON workspace_sessions(runtime_session_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_sessions_status ON workspace_sessions(status);
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (15, 'workspace-sessions-agent-terminal-split', datetime('now'));
  `);
}

function renameAgentSessionsToWorkspaceSessions(db: SqliteDatabase) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const before = countRows(db, "agent_sessions");
    db.exec(`
      ${workspaceSessionsTableSql().replace("CREATE TABLE IF NOT EXISTS workspace_sessions", "CREATE TABLE workspace_sessions_new")}
      ${copyAgentSessionsSql("workspace_sessions_new")}
    `);
    const after = countRows(db, "workspace_sessions_new");
    if (after !== before) {
      throw new Error(`workspace_sessions migration row-count mismatch: copied ${after} of ${before} rows`);
    }
    db.exec(`
      DROP TABLE agent_sessions;
      ALTER TABLE workspace_sessions_new RENAME TO workspace_sessions;
    `);
    assertNoForeignKeyViolations(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function mergeAgentSessionsIntoWorkspaceSessions(db: SqliteDatabase) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(copyAgentSessionsSql("workspace_sessions"));
    db.exec("DROP TABLE agent_sessions;");
    assertNoForeignKeyViolations(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function copyAgentSessionsSql(targetTable: string) {
  return `
    INSERT OR IGNORE INTO ${targetTable} (
      id, workspace_id, kind, runtime_id, display_name, status, status_reason, status_reason_at,
      last_status_at, last_output_at, ended_at, exit_code, transport, tmux_session_name, tmux_session_id,
      tmux_socket_name, tab_id, runtime_session_id, rate_limit_resume_attempts, next_resume_at,
      last_resume_from_rate_limit_at, created_at, updated_at
    )
    SELECT
      id,
      workspace_id,
      CASE WHEN runtime_id = 'shell' THEN 'terminal' ELSE 'agent' END AS kind,
      CASE WHEN runtime_id = 'shell' THEN NULL ELSE runtime_id END AS runtime_id,
      display_name,
      status,
      status_reason,
      status_reason_at,
      last_status_at,
      last_output_at,
      ended_at,
      exit_code,
      transport,
      tmux_session_name,
      tmux_session_id,
      tmux_socket_name,
      tab_id,
      runtime_session_id,
      rate_limit_resume_attempts,
      next_resume_at,
      last_resume_from_rate_limit_at,
      created_at,
      updated_at
    FROM agent_sessions;
  `;
}

function countRows(db: SqliteDatabase, tableName: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return Number(row.count);
}

function assertNoForeignKeyViolations(db: SqliteDatabase) {
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0) {
    throw new Error(`workspace_sessions migration produced foreign-key violations: ${JSON.stringify(violations)}`);
  }
}

function assertExpectedAgentSessionDependencies(db: SqliteDatabase) {
  const schemaRefs = db
    .prepare(
      "SELECT type, name, tbl_name AS tblName, sql FROM sqlite_schema WHERE sql LIKE '%agent_sessions%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tblName: string; sql: string | null }>;
  const unexpectedSqlRefs = schemaRefs.filter(
    (row) =>
      !(
        (row.type === "table" && row.name === "agent_sessions" && row.tblName === "agent_sessions") ||
        ((row.type === "index" || row.type === "trigger") && row.tblName === "agent_sessions")
      ),
  );
  if (unexpectedSqlRefs.length > 0) {
    throw new Error(
      `Unexpected schema objects reference agent_sessions: ${unexpectedSqlRefs.map((r) => r.name).join(", ")}`,
    );
  }

  const tables = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  const foreignKeyRefs: string[] = [];
  for (const table of tables) {
    const fks = db.prepare(`PRAGMA foreign_key_list(${table.name})`).all() as Array<{ table: string }>;
    if (table.name !== "agent_sessions" && fks.some((fk) => fk.table === "agent_sessions")) {
      foreignKeyRefs.push(table.name);
    }
  }
  if (foreignKeyRefs.length > 0) {
    throw new Error(`Unexpected foreign keys reference agent_sessions: ${foreignKeyRefs.join(", ")}`);
  }
}
