import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ActivityEvent,
  AgentPrompt,
  AgentSession,
  HookOutput,
  Operation,
  OperationLogEntry,
  Repo,
  ScheduledAgent,
  Workspace,
} from "@citadel/contracts";
import {
  activityFromRow,
  agentPromptFromRow,
  operationFromRow,
  repoFromRow,
  scheduledAgentFromRow,
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
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_session_prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        external_id TEXT,
        UNIQUE(session_id, external_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_session_prompts_session
        ON agent_session_prompts(session_id, sent_at);
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (6, 'agent-session-prompts', datetime('now'));
    `);
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
    this.database.prepare("DELETE FROM agent_session_prompts WHERE session_id = ?").run(sessionId);
    this.database.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
  }

  insertAgentPrompt(prompt: AgentPrompt): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO agent_session_prompts (id, session_id, source, role, text, sent_at, external_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prompt.id,
        prompt.sessionId,
        prompt.source,
        prompt.role,
        prompt.text,
        prompt.sentAt,
        prompt.externalId ?? null,
      );
    return result.changes > 0;
  }

  listAgentPrompts(sessionId: string): AgentPrompt[] {
    const rows = this.database
      .prepare("SELECT * FROM agent_session_prompts WHERE session_id = ? ORDER BY sent_at ASC, id ASC")
      .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map(agentPromptFromRow);
  }

  countAgentPrompts(sessionId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS c FROM agent_session_prompts WHERE session_id = ?")
      .get(sessionId) as { c: number } | undefined;
    return row ? Number(row.c) : 0;
  }

  deleteAgentPrompt(id: string) {
    this.database.prepare("DELETE FROM agent_session_prompts WHERE id = ?").run(id);
  }

  /**
   * Batched companion to `firstAgentPrompt` + `countAgentPrompts`. Used by
   * `list_agent_sessions` to avoid 2N round-trips when summarizing every
   * session's prompt history. Returns one entry per requested sessionId
   * (with empty defaults when there are no rows).
   */
  getAgentPromptSummaries(sessionIds: string[]): Map<string, { initialPrompt: string | null; messageCount: number }> {
    const out = new Map<string, { initialPrompt: string | null; messageCount: number }>();
    for (const id of sessionIds) out.set(id, { initialPrompt: null, messageCount: 0 });
    if (!sessionIds.length) return out;
    const placeholders = sessionIds.map(() => "?").join(",");
    const counts = this.database
      .prepare(
        `SELECT session_id AS sessionId, COUNT(*) AS c
         FROM agent_session_prompts
         WHERE session_id IN (${placeholders})
         GROUP BY session_id`,
      )
      .all(...sessionIds) as Array<{ sessionId: string; c: number }>;
    for (const row of counts) {
      const entry = out.get(row.sessionId);
      if (entry) entry.messageCount = Number(row.c);
    }
    const firsts = this.database
      .prepare(
        `SELECT session_id AS sessionId, text
         FROM agent_session_prompts p
         WHERE session_id IN (${placeholders})
           AND id = (
             SELECT id FROM agent_session_prompts
             WHERE session_id = p.session_id
             ORDER BY sent_at ASC, id ASC
             LIMIT 1
           )`,
      )
      .all(...sessionIds) as Array<{ sessionId: string; text: string }>;
    for (const row of firsts) {
      const entry = out.get(row.sessionId);
      if (entry) entry.initialPrompt = row.text;
    }
    return out;
  }

  firstAgentPrompt(sessionId: string): AgentPrompt | null {
    const row = this.database
      .prepare("SELECT * FROM agent_session_prompts WHERE session_id = ? ORDER BY sent_at ASC, id ASC LIMIT 1")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? agentPromptFromRow(row) : null;
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
    this.database
      .prepare(
        `INSERT INTO scheduled_agents (id, name, description, cron, repo_id, runtime_id, prompt,
          workspace_strategy, workspace_name, base_branch, enabled, last_run_at, last_run_status,
          last_run_message, last_workspace_id, last_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        agent.id,
        agent.name,
        agent.description ?? null,
        agent.cron,
        agent.repoId,
        agent.runtimeId,
        agent.prompt ?? null,
        agent.workspaceStrategy,
        agent.workspaceName,
        agent.baseBranch ?? null,
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
        | "cron"
        | "repoId"
        | "runtimeId"
        | "prompt"
        | "workspaceStrategy"
        | "workspaceName"
        | "baseBranch"
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
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE scheduled_agents SET name = ?, description = ?, cron = ?, repo_id = ?, runtime_id = ?,
          prompt = ?, workspace_strategy = ?, workspace_name = ?, base_branch = ?, enabled = ?,
          updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.cron,
        next.repoId,
        next.runtimeId,
        next.prompt ?? null,
        next.workspaceStrategy,
        next.workspaceName,
        next.baseBranch ?? null,
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

  private ensureColumn(table: string, column: string, definition: string) {
    const cols = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}
