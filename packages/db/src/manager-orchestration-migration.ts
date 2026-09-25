type SqliteDatabase = {
  exec(sql: string): void;
};

export function migrateManagerOrchestrationLedger(
  db: SqliteDatabase,
  ensureColumn: (table: string, column: string, definition: string) => void,
) {
  ensureColumn("workspace_checkouts", "delivery_unit_key", "TEXT");
  ensureColumn("workspace_checkouts", "delivery_plan_version_id", "TEXT REFERENCES workspace_plan_versions(id)");
  ensureColumn("workspace_checkouts", "manager_status", "TEXT");
  ensureColumn("workspace_checkouts", "manager_status_reason", "TEXT");
  ensureColumn("workspace_checkouts", "manager_status_updated_at", "TEXT");
  ensureColumn("checkout_review_artifacts", "invalidated_at", "TEXT");
  ensureColumn("checkout_review_artifacts", "invalidated_reason", "TEXT");
  ensureColumn("checkout_review_artifacts", "human_waived_at", "TEXT");
  ensureColumn("checkout_review_artifacts", "human_waived_by", "TEXT");
  ensureColumn("checkout_review_artifacts", "human_waiver_reason", "TEXT");
  ensureColumn("workspace_sessions", "manager_action_id", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_plan_delivery_units (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      repo_id TEXT REFERENCES repos(id),
      repo_name TEXT,
      provider_repo_url TEXT,
      checkout_name TEXT NOT NULL,
      branch TEXT NOT NULL,
      base_branch TEXT,
      child_issue_provider TEXT,
      child_issue_key TEXT,
      child_issue_url TEXT,
      child_issue_title TEXT,
      child_issue_status TEXT,
      child_issue_fetched_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(plan_version_id, key)
    );
    CREATE TABLE IF NOT EXISTS workspace_plan_dependency_edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plan_version_id TEXT NOT NULL REFERENCES workspace_plan_versions(id) ON DELETE CASCADE,
      from_unit_key TEXT NOT NULL,
      to_unit_key TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'parallel',
      reason TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(plan_version_id, from_unit_key, to_unit_key, type)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_checkouts_delivery_unit_active
      ON workspace_checkouts(workspace_id, delivery_plan_version_id, delivery_unit_key)
      WHERE delivery_unit_key IS NOT NULL AND archived_at IS NULL;
    CREATE TABLE IF NOT EXISTS manager_action_ledger (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      manager_id TEXT REFERENCES workspace_managers(id) ON DELETE SET NULL,
      action_name TEXT NOT NULL,
      status TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      action_key TEXT NOT NULL,
      fact_key TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      lease_owner_id TEXT,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      operation_id TEXT,
      session_id TEXT,
      artifact_id TEXT,
      pr_head_sha TEXT,
      plan_version_id TEXT REFERENCES workspace_plan_versions(id) ON DELETE SET NULL,
      claimed_at TEXT,
      completed_at TEXT,
      last_reconciled_at TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_manager_action_ledger_workspace_status
      ON manager_action_ledger(workspace_id, status, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manager_action_ledger_active_scope_action
      ON manager_action_ledger(workspace_id, scope_key, action_key)
      WHERE status IN ('queued', 'claimed', 'running', 'blocked');
    CREATE TABLE IF NOT EXISTS provider_issue_facts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      delivery_unit_key TEXT,
      provider_type TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      account_id TEXT,
      host_url TEXT,
      external_url TEXT,
      workspace_binding_id TEXT,
      source_binding_type TEXT NOT NULL,
      source_binding_id TEXT NOT NULL,
      issue_id TEXT,
      issue_key TEXT NOT NULL,
      title TEXT,
      status TEXT,
      acceptance_snapshot TEXT,
      fetched_at TEXT NOT NULL,
      stale_at TEXT,
      degraded_reason TEXT,
      cooldown_until TEXT,
      UNIQUE(provider_type, provider_instance_id, source_binding_type, source_binding_id, issue_key)
    );
    CREATE TABLE IF NOT EXISTS issue_transition_attempts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      manager_action_id TEXT REFERENCES manager_action_ledger(id) ON DELETE SET NULL,
      provider_type TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      account_id TEXT,
      host_url TEXT,
      external_url TEXT,
      workspace_binding_id TEXT,
      source_binding_type TEXT NOT NULL,
      source_binding_id TEXT NOT NULL,
      issue_id TEXT,
      issue_key TEXT NOT NULL,
      requested_internal_state TEXT NOT NULL,
      current_external_status TEXT,
      selected_transition TEXT,
      resulting_external_status TEXT,
      success INTEGER NOT NULL,
      degraded_reason TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS checkout_pr_facts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT NOT NULL REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      account_id TEXT,
      host_url TEXT,
      external_url TEXT,
      workspace_binding_id TEXT,
      source_binding_type TEXT NOT NULL,
      source_binding_id TEXT NOT NULL,
      repository_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
      provider_repository_key TEXT,
      pr_id TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      head_sha TEXT,
      base_ref TEXT,
      merge_state_status TEXT,
      has_conflicts INTEGER,
      fetched_at TEXT NOT NULL,
      stale_at TEXT,
      degraded_reason TEXT,
      cooldown_until TEXT,
      UNIQUE(provider_type, provider_instance_id, checkout_id, provider_repository_key, pr_id, pr_number, head_sha)
    );
    CREATE TABLE IF NOT EXISTS checkout_check_facts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT NOT NULL REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      pr_fact_id TEXT REFERENCES checkout_pr_facts(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      account_id TEXT,
      host_url TEXT,
      external_url TEXT,
      workspace_binding_id TEXT,
      source_binding_type TEXT NOT NULL,
      source_binding_id TEXT NOT NULL,
      repository_id TEXT REFERENCES repos(id) ON DELETE SET NULL,
      provider_repository_key TEXT,
      head_sha TEXT NOT NULL,
      check_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      conclusion TEXT,
      details_url TEXT,
      started_at TEXT,
      completed_at TEXT,
      fetched_at TEXT NOT NULL,
      stale_at TEXT,
      degraded_reason TEXT,
      UNIQUE(provider_type, provider_instance_id, checkout_id, head_sha, name, check_id)
    );
    CREATE TABLE IF NOT EXISTS agent_tool_authorities (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES workspace_sessions(id) ON DELETE CASCADE,
      role TEXT,
      action_id TEXT,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      plan_version_id TEXT REFERENCES workspace_plan_versions(id) ON DELETE SET NULL,
      manager_action_id TEXT REFERENCES manager_action_ledger(id) ON DELETE SET NULL,
      allowed_tool_names TEXT NOT NULL,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      revocation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_notification_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      dedupe_key TEXT NOT NULL UNIQUE,
      triggering_fact_fingerprint TEXT NOT NULL,
      manager_action_id TEXT REFERENCES manager_action_ledger(id) ON DELETE SET NULL,
      resolved_at TEXT,
      rearmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (19, 'manager-orchestration-ledger', datetime('now'));
  `);
}
