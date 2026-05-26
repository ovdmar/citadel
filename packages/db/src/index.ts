import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ActivityEvent,
  AgentSession,
  HookOutput,
  Namespace,
  Operation,
  OperationLogEntry,
  Repo,
  ScheduledAgent,
  Workspace,
} from "@citadel/contracts";
import { runMigrations } from "./migrate.js";
import * as namespaces from "./namespaces.js";
import {
  activityFromRow,
  operationFromRow,
  repoFromRow,
  scheduledAgentFromRow,
  sessionFromRow,
  workspaceFromRow,
} from "./rows.js";

// Avoid a static `import "node:sqlite"` so vite-based test runners do not
// try to bundle the built-in. Resolved through `createRequire` at runtime.
type DatabaseSyncCtor = new (path: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};
export type SqliteStatement = {
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

  /** @internal Module-augmenting files in this package access the underlying
   * database through this getter; external callers should go through the
   * named class methods instead. */
  get database(): SqliteDatabase {
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
    runMigrations(this.database, (table, column, definition) => this.ensureColumn(table, column, definition));
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
          setup_hook_ids, teardown_hook_ids, request_review_hook_ids, provider_ids, deploy_hook_command, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(repo.requestReviewHookIds ?? []),
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
      Pick<
        Repo,
        | "name"
        | "worktreeParent"
        | "setupHookIds"
        | "teardownHookIds"
        | "requestReviewHookIds"
        | "providerIds"
        | "deployHookCommand"
      >
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
      requestReviewHookIds: patch.requestReviewHookIds ?? current.requestReviewHookIds,
      providerIds: patch.providerIds ?? current.providerIds,
      deployHookCommand: patch.deployHookCommand !== undefined ? patch.deployHookCommand : current.deployHookCommand,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE repos SET name = ?, worktree_parent = ?, setup_hook_ids = ?, teardown_hook_ids = ?,
          request_review_hook_ids = ?, provider_ids = ?, deploy_hook_command = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.worktreeParent,
        JSON.stringify(next.setupHookIds),
        JSON.stringify(next.teardownHookIds),
        JSON.stringify(next.requestReviewHookIds),
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
          issue_key, issue_title, issue_url, slack_thread_url, section, pinned, lifecycle, dirty, namespace_id, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        workspace.namespaceId ?? null,
        workspace.createdAt,
        workspace.updatedAt,
        workspace.archivedAt ?? null,
      );
  }

  setWorkspaceNamespace = (id: string, n: string | null) => namespaces.setWorkspaceNamespace(this.database, id, n);
  listNamespaces = (includeArchived = false) => namespaces.listNamespaces(this.database, includeArchived);
  findNamespace = (id: string) => namespaces.findNamespace(this.database, id);
  findNamespaceByName = (n: string) => namespaces.findNamespaceByName(this.database, n);
  insertNamespace = (n: Namespace) => namespaces.insertNamespace(this.database, n);
  updateNamespace = (id: string, p: Partial<Pick<Namespace, "name" | "color">>) =>
    namespaces.updateNamespace(this.database, id, p);
  archiveNamespace = (id: string) => namespaces.archiveNamespace(this.database, id);
  restoreNamespace = (id: string, p?: { color?: string | null }) =>
    namespaces.restoreNamespace(this.database, id, p ?? {});

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

  // Hard-delete a workspace row and its agent sessions. Used when a worktree
  // was actually removed from disk so the (repo_id, name) UNIQUE slot can be
  // reused immediately — archiveWorkspace leaves the row in place and would
  // block recreation under the same name.
  deleteWorkspace(workspaceId: string) {
    this.database.prepare("DELETE FROM agent_sessions WHERE workspace_id = ?").run(workspaceId);
    this.database.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);
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
        `INSERT INTO agent_sessions (id, workspace_id, runtime_id, display_name, status, status_reason,
          last_status_at, last_output_at, ended_at, exit_code, transport,
          tmux_session_name, tmux_session_id, runtime_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceId,
        session.runtimeId,
        session.displayName,
        session.status,
        session.statusReason ?? null,
        // Optional in the schema (older test fixtures + out-of-band callers
        // may omit these); the DB layer normalizes to sensible defaults so
        // the column constraints are still satisfied.
        session.lastStatusAt ?? session.updatedAt,
        session.lastOutputAt ?? null,
        session.endedAt ?? null,
        session.exitCode ?? null,
        session.transport,
        session.tmuxSessionName ?? null,
        session.tmuxSessionId ?? null,
        session.runtimeSessionId ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  // Write the runtime-native session UUID onto an existing row. Used by the
  // backfill / Settings-restore flow to link a pre-existing on-disk transcript
  // (e.g. Claude Code's <uuid>.jsonl) to an agent_session row so the next
  // respawn picks it up via --resume.
  setSessionRuntimeSessionId(sessionId: string, runtimeSessionId: string | null) {
    this.database
      .prepare("UPDATE agent_sessions SET runtime_session_id = ?, updated_at = ? WHERE id = ?")
      .run(runtimeSessionId, new Date().toISOString(), sessionId);
  }

  // Partial update accepting any subset of mutable status-tracking fields.
  // Used by the status reducer (via @citadel/operations) to apply reducer
  // outputs without round-tripping through the full AgentSession schema.
  // Fields with `undefined` value are left unchanged; fields with `null` are
  // written as SQL NULL.
  updateSessionStatus(
    sessionId: string,
    update: {
      status?: AgentSession["status"];
      statusReason?: string | null;
      lastStatusAt?: string;
      lastOutputAt?: string | null;
      endedAt?: string | null;
      exitCode?: number | null;
    },
  ) {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (update.status !== undefined) {
      sets.push("status = ?");
      values.push(update.status);
    }
    if (update.statusReason !== undefined) {
      sets.push("status_reason = ?");
      values.push(update.statusReason);
    }
    if (update.lastStatusAt !== undefined) {
      sets.push("last_status_at = ?");
      values.push(update.lastStatusAt);
    }
    if (update.lastOutputAt !== undefined) {
      sets.push("last_output_at = ?");
      values.push(update.lastOutputAt);
    }
    if (update.endedAt !== undefined) {
      sets.push("ended_at = ?");
      values.push(update.endedAt);
    }
    if (update.exitCode !== undefined) {
      sets.push("exit_code = ?");
      values.push(update.exitCode);
    }
    if (sets.length === 0) return; // nothing to do
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(sessionId);
    this.database.prepare(`UPDATE agent_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
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

import { reviewStoreMethods } from "./review.js";
// Attach the scheduled_agent_runs and background_sessions methods to
// SqliteStore.prototype. The implementations live in scheduled-run-store.ts
// (kept separate to stay under the per-file line budget); the type
// declarations there augment this class via `declare module`. We can't do
// the assignment inside scheduled-run-store.ts itself because ES module
// hoisting would run it before this class declaration completes.
import { scheduledRunStoreMethods } from "./scheduled-run-store.js";
Object.assign(SqliteStore.prototype, scheduledRunStoreMethods);
Object.assign(SqliteStore.prototype, reviewStoreMethods);
export type {
  InsertReviewCommentInput,
  InsertReviewSuggestionRunInput,
  ListReviewCommentsOptions,
  ReviewCommentMutationResult,
  ReviewCommentPatch,
} from "./review.js";
