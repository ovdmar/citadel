import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ActivityEvent,
  AgentSession,
  BackgroundAgentSession,
  HookOutput,
  Operation,
  OperationLogEntry,
  Repo,
  ScheduledAgent,
  ScheduledAgentRun,
  Workspace,
} from "@citadel/contracts";
import {
  activityFromRow,
  backgroundSessionFromRow,
  operationFromRow,
  repoFromRow,
  scheduledAgentFromRow,
  scheduledAgentRunFromRow,
  sessionFromRow,
  workspaceFromRow,
} from "./rows.js";

// Avoid a static `import "node:sqlite"` so vite-based test runners do not
// try to bundle the built-in. Resolved through `createRequire` at runtime.
type DatabaseSyncCtor = new (path: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number };
};

// Sentinel cron written for one-shot rows. Must never match a real minute:
// dom=31 + mon=2 with dow wild yields cronMatches() === false for every date
// (Feb has no 31st). Earlier "0 0 31 2 0" was unsafe because dom/dow
// non-wild use OR semantics and would fire every Sunday in February.
const ONE_SHOT_CRON_PLACEHOLDER = "0 0 31 2 *";

let DatabaseSyncCtor: DatabaseSyncCtor | null = null;
function loadDatabaseSync(): DatabaseSyncCtor {
  if (DatabaseSyncCtor) return DatabaseSyncCtor;
  const requireFn = createRequire(import.meta.url);
  const mod = requireFn("node:sqlite") as { DatabaseSync: DatabaseSyncCtor };
  DatabaseSyncCtor = mod.DatabaseSync;
  return DatabaseSyncCtor;
}

export class SqliteStore {
  readonly databasePath: string;
  private db: SqliteDatabase | null = null;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
  }

  private get database(): SqliteDatabase {
    if (!this.db) {
      fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
      const Ctor = loadDatabaseSync();
      this.db = new Ctor(this.databasePath);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    }
    return this.db;
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      this.db = null;
    }
  }

  migrate() {
    const db = this.database;
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
    this.ensureColumn("activity_events", "hook_output", "TEXT");
    this.ensureColumn("operations", "logs", "TEXT");
    this.ensureColumn("operations", "retriable", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("operations", "retry_input", "TEXT");
    this.ensureColumn("workspaces", "issue_url", "TEXT");
    this.ensureColumn("workspaces", "slack_thread_url", "TEXT");
    this.ensureColumn("workspaces", "kind", "TEXT NOT NULL DEFAULT 'worktree'");
    this.ensureColumn("repos", "deploy_hook_command", "TEXT");
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
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (2, 'activity-hook-output', datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (3, 'operation-logs-retry', datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (4, 'workspace-linked-urls', datetime('now'));
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (5, 'scheduled-agents', datetime('now'));
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
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (6, 'background-sessions-and-runs', datetime('now'));
    `);
    this.ensureColumn("scheduled_agents", "schedule_type", "TEXT NOT NULL DEFAULT 'recurring'");
    this.ensureColumn("scheduled_agents", "run_at", "TEXT");
    this.ensureColumn("scheduled_agents", "run_mode", "TEXT NOT NULL DEFAULT 'workspace'");
    this.ensureColumn("scheduled_agents", "background_cwd", "TEXT");
    this.ensureColumn("scheduled_agents", "overlap_policy", "TEXT NOT NULL DEFAULT 'skip'");
  }

  exec(sql: string) {
    this.database.exec(sql);
  }

  query<T>(sql: string): T[] {
    return this.database.prepare(sql).all() as unknown as T[];
  }

  listRepos(): Repo[] {
    return this.database
      .prepare("SELECT * FROM repos WHERE archived_at IS NULL ORDER BY name")
      .all()
      .map((row) => repoFromRow(row as Record<string, unknown>));
  }

  insertRepo(repo: Repo) {
    this.database
      .prepare(
        `INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent,
          setup_hook_ids, teardown_hook_ids, provider_ids, deploy_hook_command, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo.id,
        repo.name,
        repo.rootPath,
        repo.defaultBranch,
        repo.defaultRemote,
        repo.worktreeParent,
        JSON.stringify(repo.setupHookIds),
        JSON.stringify(repo.teardownHookIds),
        JSON.stringify(repo.providerIds),
        repo.deployHookCommand ?? null,
        repo.createdAt,
        repo.updatedAt,
        repo.archivedAt ?? null,
      );
  }

  updateRepo(
    repoId: string,
    patch: Partial<
      Pick<Repo, "name" | "worktreeParent" | "setupHookIds" | "teardownHookIds" | "providerIds" | "deployHookCommand">
    >,
  ) {
    const existing = this.database.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return null;
    const current = repoFromRow(existing);
    const next: Repo = {
      ...current,
      name: patch.name ?? current.name,
      worktreeParent: patch.worktreeParent ?? current.worktreeParent,
      setupHookIds: patch.setupHookIds ?? current.setupHookIds,
      teardownHookIds: patch.teardownHookIds ?? current.teardownHookIds,
      providerIds: patch.providerIds ?? current.providerIds,
      deployHookCommand: patch.deployHookCommand !== undefined ? patch.deployHookCommand : current.deployHookCommand,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE repos SET name = ?, worktree_parent = ?, setup_hook_ids = ?, teardown_hook_ids = ?,
          provider_ids = ?, deploy_hook_command = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.worktreeParent,
        JSON.stringify(next.setupHookIds),
        JSON.stringify(next.teardownHookIds),
        JSON.stringify(next.providerIds),
        next.deployHookCommand ?? null,
        next.updatedAt,
        repoId,
      );
    return next;
  }

  listWorkspaces(repoId?: string): Workspace[] {
    const stmt = repoId
      ? this.database.prepare(
          "SELECT * FROM workspaces WHERE repo_id = ? AND archived_at IS NULL ORDER BY updated_at DESC",
        )
      : this.database.prepare("SELECT * FROM workspaces WHERE archived_at IS NULL ORDER BY updated_at DESC");
    const rows = (repoId ? stmt.all(repoId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(workspaceFromRow);
  }

  insertWorkspace(workspace: Workspace) {
    this.database
      .prepare(
        `INSERT INTO workspaces (id, repo_id, name, path, branch, base_branch, source, kind, pr_url,
          issue_key, issue_title, issue_url, slack_thread_url, section, pinned, lifecycle, dirty, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        workspace.id,
        workspace.repoId,
        workspace.name,
        workspace.path,
        workspace.branch,
        workspace.baseBranch,
        workspace.source,
        workspace.kind ?? "worktree",
        workspace.prUrl ?? null,
        workspace.issueKey ?? null,
        workspace.issueTitle ?? null,
        workspace.issueUrl ?? null,
        workspace.slackThreadUrl ?? null,
        workspace.section,
        workspace.pinned ? 1 : 0,
        workspace.lifecycle,
        workspace.dirty ? 1 : 0,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt ?? null,
      );
  }

  updateWorkspaceLifecycle(workspaceId: string, lifecycle: Workspace["lifecycle"], dirty = false) {
    this.database
      .prepare("UPDATE workspaces SET lifecycle = ?, dirty = ?, updated_at = ? WHERE id = ?")
      .run(lifecycle, dirty ? 1 : 0, new Date().toISOString(), workspaceId);
  }

  updateWorkspace(
    workspaceId: string,
    patch: Partial<Pick<Workspace, "name" | "issueKey" | "issueTitle" | "issueUrl" | "slackThreadUrl" | "pinned">>,
  ) {
    const fields: string[] = [];
    const values: unknown[] = [];
    if (typeof patch.name === "string") {
      fields.push("name = ?");
      values.push(patch.name);
    }
    if (patch.issueKey !== undefined) {
      fields.push("issue_key = ?");
      values.push(patch.issueKey ?? null);
    }
    if (patch.issueTitle !== undefined) {
      fields.push("issue_title = ?");
      values.push(patch.issueTitle ?? null);
    }
    if (patch.issueUrl !== undefined) {
      fields.push("issue_url = ?");
      values.push(patch.issueUrl ?? null);
    }
    if (patch.slackThreadUrl !== undefined) {
      fields.push("slack_thread_url = ?");
      values.push(patch.slackThreadUrl ?? null);
    }
    if (patch.pinned !== undefined) {
      fields.push("pinned = ?");
      values.push(patch.pinned ? 1 : 0);
    }
    if (!fields.length) return;
    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(workspaceId);
    this.database.prepare(`UPDATE workspaces SET ${fields.join(", ")} WHERE id = ?`).run(...(values as unknown[]));
  }

  archiveWorkspace(workspaceId: string, lifecycle: Workspace["lifecycle"], dirty = false) {
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE workspaces SET lifecycle = ?, dirty = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(lifecycle, dirty ? 1 : 0, now, now, workspaceId);
  }

  listArchivedWorkspaces(): Workspace[] {
    const rows = this.database
      .prepare("SELECT * FROM workspaces WHERE archived_at IS NOT NULL ORDER BY archived_at DESC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(workspaceFromRow);
  }

  unarchiveWorkspace(workspaceId: string) {
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE workspaces SET archived_at = NULL, lifecycle = 'ready', updated_at = ? WHERE id = ?")
      .run(now, workspaceId);
  }

  archiveRepo(repoId: string) {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE repos SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, repoId);
    this.database
      .prepare(
        "UPDATE workspaces SET lifecycle = 'archived', archived_at = ?, updated_at = ? WHERE repo_id = ? AND archived_at IS NULL",
      )
      .run(now, now, repoId);
  }

  listSessions(workspaceId?: string): AgentSession[] {
    const stmt = workspaceId
      ? this.database.prepare("SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      : this.database.prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC");
    const rows = (workspaceId ? stmt.all(workspaceId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(sessionFromRow);
  }

  insertSession(session: AgentSession) {
    this.database
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, runtime_id, display_name, status, transport,
          tmux_session_name, tmux_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceId,
        session.runtimeId,
        session.displayName,
        session.status,
        session.transport,
        session.tmuxSessionName ?? null,
        session.tmuxSessionId ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  updateSessionStatus(sessionId: string, status: AgentSession["status"]) {
    this.database
      .prepare("UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, new Date().toISOString(), sessionId);
  }

  updateSessionDisplayName(sessionId: string, displayName: string) {
    this.database
      .prepare("UPDATE agent_sessions SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName, new Date().toISOString(), sessionId);
  }

  deleteSession(sessionId: string) {
    this.database.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
  }

  upsertOperation(operation: Operation) {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO operations (id, type, status, repo_id, workspace_id, progress, message,
          error, logs, retriable, retry_input, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operation.id,
        operation.type,
        operation.status,
        operation.repoId ?? null,
        operation.workspaceId ?? null,
        operation.progress,
        operation.message ?? null,
        operation.error ?? null,
        JSON.stringify(operation.logs ?? []),
        operation.retriable ? 1 : 0,
        operation.retryInput ? JSON.stringify(operation.retryInput) : null,
        operation.createdAt,
        operation.updatedAt,
      );
  }

  appendOperationLog(operationId: string, entry: OperationLogEntry) {
    const existing = this.database.prepare("SELECT logs FROM operations WHERE id = ?").get(operationId) as
      | { logs: string | null }
      | undefined;
    if (!existing) return;
    const logs = existing.logs ? (JSON.parse(existing.logs) as OperationLogEntry[]) : [];
    logs.push(entry);
    this.database
      .prepare("UPDATE operations SET logs = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(logs.slice(-200)), new Date().toISOString(), operationId);
  }

  listOperations(): Operation[] {
    const rows = this.database.prepare("SELECT * FROM operations ORDER BY updated_at DESC LIMIT 100").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(operationFromRow);
  }

  findOperation(operationId: string): Operation | null {
    const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(operationId);
    if (!row) return null;
    return operationFromRow(row as Record<string, unknown>);
  }

  addActivity(event: Omit<ActivityEvent, "hookOutput"> & { hookOutput?: HookOutput | null }) {
    this.database
      .prepare(
        `INSERT INTO activity_events (id, type, source, repo_id, workspace_id, operation_id, message,
          hook_output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.type,
        event.source,
        event.repoId ?? null,
        event.workspaceId ?? null,
        event.operationId ?? null,
        event.message,
        event.hookOutput ? JSON.stringify(event.hookOutput) : null,
        event.createdAt,
      );
  }

  listActivity(workspaceId?: string): ActivityEvent[] {
    const stmt = workspaceId
      ? this.database.prepare("SELECT * FROM activity_events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200")
      : this.database.prepare("SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 200");
    const rows = (workspaceId ? stmt.all(workspaceId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(activityFromRow);
  }

  listScheduledAgents(): ScheduledAgent[] {
    const rows = this.database.prepare("SELECT * FROM scheduled_agents ORDER BY created_at DESC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(scheduledAgentFromRow);
  }

  findScheduledAgent(id: string): ScheduledAgent | null {
    const row = this.database.prepare("SELECT * FROM scheduled_agents WHERE id = ?").get(id);
    if (!row) return null;
    return scheduledAgentFromRow(row as Record<string, unknown>);
  }

  insertScheduledAgent(agent: ScheduledAgent) {
    // cron is NOT NULL at the DB level. One-shot rows store a sentinel that
    // never matches a real minute so the recurring tick is a no-op for them.
    const cronColumn = agent.cron ?? ONE_SHOT_CRON_PLACEHOLDER;
    this.database
      .prepare(
        `INSERT INTO scheduled_agents (id, name, description, cron, schedule_type, run_at, repo_id, runtime_id, prompt,
          workspace_strategy, workspace_name, base_branch, run_mode, background_cwd, overlap_policy,
          enabled, last_run_at, last_run_status,
          last_run_message, last_workspace_id, last_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.description ?? null,
        cronColumn,
        agent.scheduleType,
        agent.runAt ?? null,
        agent.repoId,
        agent.runtimeId,
        agent.prompt ?? null,
        agent.workspaceStrategy,
        agent.workspaceName,
        agent.baseBranch ?? null,
        agent.runMode,
        agent.backgroundCwd ?? null,
        agent.overlapPolicy,
        agent.enabled ? 1 : 0,
        agent.lastRunAt ?? null,
        agent.lastRunStatus,
        agent.lastRunMessage ?? null,
        agent.lastWorkspaceId ?? null,
        agent.lastSessionId ?? null,
        agent.createdAt,
        agent.updatedAt,
      );
  }

  updateScheduledAgent(
    id: string,
    patch: Partial<
      Pick<
        ScheduledAgent,
        | "name"
        | "description"
        | "scheduleType"
        | "cron"
        | "runAt"
        | "repoId"
        | "runtimeId"
        | "prompt"
        | "workspaceStrategy"
        | "workspaceName"
        | "baseBranch"
        | "runMode"
        | "backgroundCwd"
        | "overlapPolicy"
        | "enabled"
      >
    >,
  ): ScheduledAgent | null {
    const existing = this.findScheduledAgent(id);
    if (!existing) return null;
    const next: ScheduledAgent = {
      ...existing,
      ...patch,
      description: patch.description !== undefined ? patch.description : existing.description,
      prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
      baseBranch: patch.baseBranch !== undefined ? patch.baseBranch : existing.baseBranch,
      runAt: patch.runAt !== undefined ? patch.runAt : existing.runAt,
      cron: patch.cron !== undefined ? patch.cron : existing.cron,
      backgroundCwd: patch.backgroundCwd !== undefined ? patch.backgroundCwd : existing.backgroundCwd,
      updatedAt: new Date().toISOString(),
    };
    const cronColumn = next.cron ?? ONE_SHOT_CRON_PLACEHOLDER;
    this.database
      .prepare(
        `UPDATE scheduled_agents SET name = ?, description = ?, cron = ?, schedule_type = ?, run_at = ?,
          repo_id = ?, runtime_id = ?, prompt = ?, workspace_strategy = ?, workspace_name = ?,
          base_branch = ?, run_mode = ?, background_cwd = ?, overlap_policy = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.name,
        next.description ?? null,
        cronColumn,
        next.scheduleType,
        next.runAt ?? null,
        next.repoId,
        next.runtimeId,
        next.prompt ?? null,
        next.workspaceStrategy,
        next.workspaceName,
        next.baseBranch ?? null,
        next.runMode,
        next.backgroundCwd ?? null,
        next.overlapPolicy,
        next.enabled ? 1 : 0,
        next.updatedAt,
        id,
      );
    return next;
  }

  recordScheduledAgentRun(
    id: string,
    update: {
      lastRunAt: string;
      lastRunStatus: ScheduledAgent["lastRunStatus"];
      lastRunMessage?: string | null;
      lastWorkspaceId?: string | null;
      lastSessionId?: string | null;
    },
  ): ScheduledAgent | null {
    const existing = this.findScheduledAgent(id);
    if (!existing) return null;
    const next: ScheduledAgent = {
      ...existing,
      lastRunAt: update.lastRunAt,
      lastRunStatus: update.lastRunStatus,
      lastRunMessage: update.lastRunMessage !== undefined ? update.lastRunMessage : existing.lastRunMessage,
      lastWorkspaceId: update.lastWorkspaceId !== undefined ? update.lastWorkspaceId : existing.lastWorkspaceId,
      lastSessionId: update.lastSessionId !== undefined ? update.lastSessionId : existing.lastSessionId,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE scheduled_agents SET last_run_at = ?, last_run_status = ?, last_run_message = ?,
          last_workspace_id = ?, last_session_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.lastRunAt,
        next.lastRunStatus,
        next.lastRunMessage ?? null,
        next.lastWorkspaceId ?? null,
        next.lastSessionId ?? null,
        next.updatedAt,
        id,
      );
    return next;
  }

  deleteScheduledAgent(id: string) {
    this.database.prepare("DELETE FROM scheduled_agents WHERE id = ?").run(id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // scheduled_agent_runs

  insertScheduledAgentRun(run: ScheduledAgentRun) {
    this.database
      .prepare(
        `INSERT INTO scheduled_agent_runs (id, scheduled_agent_id, status, enqueued_at, started_at, ended_at,
          message, workspace_id, session_id, background_session_id, log_file_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.scheduledAgentId,
        run.status,
        run.enqueuedAt,
        run.startedAt ?? null,
        run.endedAt ?? null,
        run.message ?? null,
        run.workspaceId ?? null,
        run.sessionId ?? null,
        run.backgroundSessionId ?? null,
        run.logFilePath ?? null,
      );
  }

  findScheduledAgentRun(id: string): ScheduledAgentRun | null {
    const row = this.database.prepare("SELECT * FROM scheduled_agent_runs WHERE id = ?").get(id);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  }

  listScheduledAgentRuns(
    scheduledAgentId: string,
    options: { limit?: number; offset?: number } = {},
  ): ScheduledAgentRun[] {
    // DESC by enqueued_at so the History drawer shows most-recent first;
    // queued and terminal rows interleave correctly because every row has an
    // enqueued_at stamped at fire time.
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const rows = this.database
      .prepare(
        `SELECT * FROM scheduled_agent_runs
         WHERE scheduled_agent_id = ?
         ORDER BY enqueued_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(scheduledAgentId, limit, offset) as Array<Record<string, unknown>>;
    return rows.map(scheduledAgentRunFromRow);
  }

  findInFlightScheduledAgentRun(scheduledAgentId: string): ScheduledAgentRun | null {
    const row = this.database
      .prepare(
        `SELECT * FROM scheduled_agent_runs
         WHERE scheduled_agent_id = ? AND status = 'running'
         ORDER BY enqueued_at DESC LIMIT 1`,
      )
      .get(scheduledAgentId);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  }

  listInFlightScheduledAgentRuns(): ScheduledAgentRun[] {
    const rows = this.database
      .prepare("SELECT * FROM scheduled_agent_runs WHERE status = 'running' ORDER BY enqueued_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(scheduledAgentRunFromRow);
  }

  countQueuedScheduledAgentRuns(scheduledAgentId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS n FROM scheduled_agent_runs WHERE scheduled_agent_id = ? AND status = 'queued'")
      .get(scheduledAgentId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  findOldestQueuedScheduledAgentRun(scheduledAgentId: string): ScheduledAgentRun | null {
    const row = this.database
      .prepare(
        `SELECT * FROM scheduled_agent_runs
         WHERE scheduled_agent_id = ? AND status = 'queued'
         ORDER BY enqueued_at ASC, id ASC LIMIT 1`,
      )
      .get(scheduledAgentId);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  }

  promoteScheduledAgentRunToRunning(
    id: string,
    update: { startedAt: string; logFilePath: string },
  ): ScheduledAgentRun | null {
    this.database
      .prepare(
        `UPDATE scheduled_agent_runs SET status = 'running', started_at = ?, log_file_path = ?
         WHERE id = ? AND status = 'queued'`,
      )
      .run(update.startedAt, update.logFilePath, id);
    return this.findScheduledAgentRun(id);
  }

  recordScheduledAgentRunOutcome(
    id: string,
    update: {
      status: ScheduledAgentRun["status"];
      endedAt: string;
      message?: string | null;
      workspaceId?: string | null;
      sessionId?: string | null;
      backgroundSessionId?: string | null;
    },
  ): ScheduledAgentRun | null {
    const existing = this.findScheduledAgentRun(id);
    if (!existing) return null;
    const next: ScheduledAgentRun = {
      ...existing,
      status: update.status,
      endedAt: update.endedAt,
      message: update.message !== undefined ? update.message : existing.message,
      workspaceId: update.workspaceId !== undefined ? update.workspaceId : existing.workspaceId,
      sessionId: update.sessionId !== undefined ? update.sessionId : existing.sessionId,
      backgroundSessionId:
        update.backgroundSessionId !== undefined ? update.backgroundSessionId : existing.backgroundSessionId,
    };
    this.database
      .prepare(
        `UPDATE scheduled_agent_runs SET status = ?, ended_at = ?, message = ?,
          workspace_id = ?, session_id = ?, background_session_id = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.endedAt,
        next.message ?? null,
        next.workspaceId ?? null,
        next.sessionId ?? null,
        next.backgroundSessionId ?? null,
        id,
      );
    return next;
  }

  // ────────────────────────────────────────────────────────────────────────
  // background_sessions

  insertBackgroundSession(session: BackgroundAgentSession) {
    this.database
      .prepare(
        `INSERT INTO background_sessions (id, scheduled_agent_id, cwd, log_file_path,
          tmux_session_name, tmux_session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.scheduledAgentId ?? null,
        session.cwd,
        session.logFilePath,
        session.tmuxSessionName,
        session.tmuxSessionId,
        session.status,
        session.createdAt,
        session.updatedAt,
      );
  }

  findBackgroundSession(id: string): BackgroundAgentSession | null {
    const row = this.database.prepare("SELECT * FROM background_sessions WHERE id = ?").get(id);
    if (!row) return null;
    return backgroundSessionFromRow(row as Record<string, unknown>);
  }

  findBackgroundSessionsByScheduledAgent(scheduledAgentId: string): BackgroundAgentSession[] {
    const rows = this.database
      .prepare("SELECT * FROM background_sessions WHERE scheduled_agent_id = ? ORDER BY created_at DESC")
      .all(scheduledAgentId) as Array<Record<string, unknown>>;
    return rows.map(backgroundSessionFromRow);
  }

  listRunningBackgroundSessions(): BackgroundAgentSession[] {
    const rows = this.database
      .prepare("SELECT * FROM background_sessions WHERE status = 'running' ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(backgroundSessionFromRow);
  }

  updateBackgroundSessionStatus(id: string, status: BackgroundAgentSession["status"]): BackgroundAgentSession | null {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE background_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    return this.findBackgroundSession(id);
  }

  deleteBackgroundSession(id: string) {
    this.database.prepare("DELETE FROM background_sessions WHERE id = ?").run(id);
  }

  // ────────────────────────────────────────────────────────────────────────
  // Cascade delete: returns the cleanup metadata (log paths + tmux session
  // names) the operations layer needs to perform fs/tmux cleanup. The DB-side
  // delete runs in one transaction so the data side never races a concurrent
  // reader. Caller is responsible for the side-effecting cleanup.

  deleteScheduledAgentCascade(id: string): { logFilePaths: string[]; tmuxSessionNames: string[] } | null {
    const existing = this.findScheduledAgent(id);
    if (!existing) return null;
    const runs = this.listScheduledAgentRuns(id, { limit: 500 });
    const bgSessions = this.findBackgroundSessionsByScheduledAgent(id);
    const logFilePaths = runs
      .map((run) => run.logFilePath)
      .filter((path): path is string => typeof path === "string" && path.length > 0);
    const tmuxSessionNames = bgSessions.map((row) => row.tmuxSessionName);
    const tx = this.database.prepare("BEGIN");
    const commit = this.database.prepare("COMMIT");
    const rollback = this.database.prepare("ROLLBACK");
    tx.run();
    try {
      this.database.prepare("DELETE FROM scheduled_agent_runs WHERE scheduled_agent_id = ?").run(id);
      this.database.prepare("DELETE FROM background_sessions WHERE scheduled_agent_id = ?").run(id);
      this.database.prepare("DELETE FROM scheduled_agents WHERE id = ?").run(id);
      commit.run();
    } catch (error) {
      rollback.run();
      throw error;
    }
    return { logFilePaths, tmuxSessionNames };
  }

  /**
   * Reset the run tracking on a scheduled agent without recording a new run.
   * Used when the user PATCHes a one-shot's schedule and we need the tick
   * guard to treat the agent as un-fired again.
   */
  resetScheduledAgentRun(id: string): ScheduledAgent | null {
    const existing = this.findScheduledAgent(id);
    if (!existing) return null;
    const next: ScheduledAgent = {
      ...existing,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunMessage: null,
      lastWorkspaceId: null,
      lastSessionId: null,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE scheduled_agents SET last_run_at = NULL, last_run_status = 'never', last_run_message = NULL,
          last_workspace_id = NULL, last_session_id = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(next.updatedAt, id);
    return next;
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const cols = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
