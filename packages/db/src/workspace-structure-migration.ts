type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number };
  };
};

export function migrateWorkspaceHomeCheckoutsManager(
  db: SqliteDatabase,
  ensureColumn: (table: string, column: string, definition: string) => void,
) {
  ensureColumn("workspaces", "root_path", "TEXT");
  ensureColumn("workspaces", "mode", "TEXT NOT NULL DEFAULT 'freestyle'");
  ensureColumn("workspaces", "lifecycle_phase", "TEXT NOT NULL DEFAULT 'implementation'");
  ensureColumn("workspaces", "parent_issue_provider", "TEXT");
  ensureColumn("workspaces", "parent_issue_key", "TEXT");
  ensureColumn("workspaces", "parent_issue_url", "TEXT");
  ensureColumn("workspaces", "parent_issue_title", "TEXT");
  ensureColumn("workspaces", "parent_issue_status", "TEXT");
  ensureColumn("workspace_sessions", "target_type", "TEXT NOT NULL DEFAULT 'worktree_checkout'");
  ensureColumn("workspace_sessions", "checkout_id", "TEXT");
  ensureColumn("workspace_sessions", "role", "TEXT");
  ensureColumn("workspace_sessions", "action_id", "TEXT");
  ensureColumn("workspace_sessions", "managed", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("workspace_sessions", "parent_session_id", "TEXT");
  ensureColumn("workspace_sessions", "plan_version_id", "TEXT");
  ensureColumn("workspace_sessions", "closed_at", "TEXT");
  ensureColumn("workspace_sessions", "launch_warnings", "TEXT");
  db.exec(`
    UPDATE workspaces
    SET root_path = path
    WHERE root_path IS NULL OR root_path = '';
    UPDATE workspaces
    SET parent_issue_provider = COALESCE(parent_issue_provider, CASE WHEN issue_key IS NOT NULL THEN 'jira' END),
        parent_issue_key = COALESCE(parent_issue_key, issue_key),
        parent_issue_url = COALESCE(parent_issue_url, issue_url),
        parent_issue_title = COALESCE(parent_issue_title, issue_title)
    WHERE issue_key IS NOT NULL;
  `);
  relaxWorkspacesRepoId(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_checkouts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL REFERENCES repos(id),
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      issue_provider TEXT,
      issue_key TEXT,
      issue_url TEXT,
      issue_title TEXT,
      issue_status TEXT,
      issue_fetched_at TEXT,
      intended_pr_provider TEXT,
      intended_pr_number INTEGER,
      intended_pr_url TEXT,
      pr_head_sha TEXT,
      pr_base_ref TEXT,
      intended_pr_fetched_at TEXT,
      intended_pr_checks_green INTEGER,
      intended_pr_merge_state_status TEXT,
      intended_pr_has_conflicts INTEGER,
      stack_parent_checkout_id TEXT REFERENCES workspace_checkouts(id),
      inferred_purpose TEXT,
      gate_status TEXT NOT NULL DEFAULT 'not_started',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE(workspace_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_checkouts_workspace ON workspace_checkouts(workspace_id);
    CREATE INDEX IF NOT EXISTS idx_workspace_checkouts_repo ON workspace_checkouts(repo_id);
  `);
  ensureColumn("workspace_checkouts", "issue_title", "TEXT");
  ensureColumn("workspace_checkouts", "issue_status", "TEXT");
  ensureColumn("workspace_checkouts", "issue_fetched_at", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_fetched_at", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_checks_green", "INTEGER");
  ensureColumn("workspace_checkouts", "intended_pr_merge_state_status", "TEXT");
  ensureColumn("workspace_checkouts", "intended_pr_has_conflicts", "INTEGER");
  db.exec(`
    INSERT OR IGNORE INTO workspace_checkouts (
      id, workspace_id, repo_id, name, path, branch, base_branch, issue_provider, issue_key, issue_url, issue_title,
      intended_pr_provider, intended_pr_url, gate_status, created_at, updated_at, archived_at
    )
    SELECT 'checkout_' || id, id, repo_id, name, path, branch, base_branch,
      CASE WHEN issue_key IS NOT NULL THEN 'jira' END, issue_key, issue_url, issue_title,
      CASE WHEN pr_url IS NOT NULL THEN 'github' END, pr_url, 'not_started', created_at, updated_at, archived_at
    FROM workspaces
    WHERE repo_id IS NOT NULL AND kind = 'worktree';
    CREATE TABLE IF NOT EXISTS workspace_plan_versions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      status TEXT NOT NULL,
      path TEXT,
      hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      approval_mode TEXT NOT NULL DEFAULT 'manual',
      created_by_session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, version)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_plan_versions_one_active
      ON workspace_plan_versions(workspace_id)
      WHERE active = 1;
    CREATE TABLE IF NOT EXISTS workspace_plan_reviews (
      id TEXT PRIMARY KEY,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      reviewer TEXT NOT NULL,
      result TEXT NOT NULL,
      artifact_path TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_plan_decisions (
      id TEXT PRIMARY KEY,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      decision TEXT NOT NULL,
      reason TEXT,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace_managers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
      pause_state TEXT NOT NULL DEFAULT 'running',
      heartbeat_interval_seconds INTEGER NOT NULL DEFAULT 300,
      last_heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS manager_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      manager_id TEXT NOT NULL REFERENCES workspace_managers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      action_key TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_deviation_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      severity TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      reported_by_session_id TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS checkout_review_artifacts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT NOT NULL REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      pr_provider TEXT NOT NULL,
      pr_number INTEGER,
      pr_url TEXT,
      head_sha TEXT NOT NULL,
      result TEXT NOT NULL,
      findings_status TEXT NOT NULL,
      blocking_findings TEXT NOT NULL DEFAULT '[]',
      artifact_path TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(checkout_id, head_sha, plan_version_id)
    );
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (16, 'workspace-home-checkouts-manager', datetime('now'));
  `);
}

function relaxWorkspacesRepoId(db: SqliteDatabase) {
  const cols = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string; notnull: number }>;
  const repoId = cols.find((col) => col.name === "repo_id");
  if (!repoId || repoId.notnull === 0) return;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE workspaces_new (
          id TEXT PRIMARY KEY,
          repo_id TEXT REFERENCES repos(id),
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          root_path TEXT NOT NULL,
          mode TEXT NOT NULL DEFAULT 'freestyle',
          branch TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          source TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'worktree',
          lifecycle_phase TEXT NOT NULL DEFAULT 'implementation',
          parent_issue_provider TEXT,
          parent_issue_key TEXT,
          parent_issue_url TEXT,
          parent_issue_title TEXT,
          parent_issue_status TEXT,
          pr_url TEXT,
          issue_key TEXT,
          issue_title TEXT,
          issue_url TEXT,
          slack_thread_url TEXT,
          section TEXT NOT NULL,
          pinned INTEGER NOT NULL,
          lifecycle TEXT NOT NULL,
          dirty INTEGER NOT NULL,
          namespace_id TEXT REFERENCES namespaces(id),
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
        INSERT INTO workspaces_new (
          id, repo_id, name, path, root_path, mode, branch, base_branch, source, kind, lifecycle_phase,
          parent_issue_provider, parent_issue_key, parent_issue_url, parent_issue_title, parent_issue_status,
          pr_url, issue_key, issue_title, issue_url, slack_thread_url, section, pinned, lifecycle, dirty,
          namespace_id, auto_recovery_last_ci_sha, auto_recovery_last_attempt_at, pr_number, pr_state,
          pr_last_fetch_at, pr_last_checks_green_at, pr_last_head_sha, pr_last_head_sha_changed_at,
          pr_last_merge_state_status, created_at, updated_at, archived_at
        )
        SELECT
          id, repo_id, name, path, COALESCE(NULLIF(root_path, ''), path), mode, branch, base_branch, source, kind,
          lifecycle_phase, parent_issue_provider, parent_issue_key, parent_issue_url, parent_issue_title,
          parent_issue_status, pr_url, issue_key, issue_title, issue_url, slack_thread_url, section, pinned,
          lifecycle, dirty, namespace_id, auto_recovery_last_ci_sha, auto_recovery_last_attempt_at, pr_number,
          pr_state, pr_last_fetch_at, pr_last_checks_green_at, pr_last_head_sha, pr_last_head_sha_changed_at,
          pr_last_merge_state_status, created_at, updated_at, archived_at
        FROM workspaces;
        DROP TABLE workspaces;
        ALTER TABLE workspaces_new RENAME TO workspaces;
      `);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}
