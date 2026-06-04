import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type {
  ActivityEvent,
  AgentSession,
  HookOutput,
  IssueBinding,
  Namespace,
  Operation,
  OperationLogEntry,
  Repo,
  Workspace,
  WorkspaceSession,
} from "@citadel/contracts";
import { runMigrations } from "./migrate.js";

export { CURRENT_SCHEMA_VERSION } from "./migrate.js";
import * as namespaces from "./namespaces.js";
import { activityFromRow, operationFromRow, repoFromRow, sessionFromRow, workspaceFromRow } from "./rows.js";
import {
  type WorkspacePrSnapshot,
  getWorkspacePrSnapshot,
  updateWorkspacePrSnapshot,
} from "./workspace-pr-snapshot.js";
import type { LegacyAgentSessionInput, WorkspaceSessionInput } from "./workspace-session-input.js";

export type { WorkspacePrSnapshot };
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
  private columns = new Map<string, Set<string>>();

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
      } catch {}
      this.db = null;
      this.columns.clear();
    }
  }

  migrate() {
    runMigrations(this.database, (table, column, definition) => this.ensureColumn(table, column, definition));
  }

  exec(sql: string) {
    this.database.exec(sql);
    this.columns.clear();
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
    const columns = [
      "id",
      "repo_id",
      "name",
      "path",
      "branch",
      "base_branch",
      "source",
      "kind",
      "pr_url",
      "issue_key",
      "issue_title",
      "issue_url",
      "slack_thread_url",
      "section",
      "pinned",
      "lifecycle",
      "dirty",
      "namespace_id",
      "created_at",
      "updated_at",
      "archived_at",
    ];
    const values: unknown[] = [
      workspace.id,
      workspace.repoId ?? null,
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
    ];
    const optionalColumns: Array<[string, unknown]> = [
      ["root_path", workspace.rootPath ?? workspace.path],
      ["mode", workspace.mode ?? "freestyle"],
      ["lifecycle_phase", workspace.lifecyclePhase ?? "implementation"],
      ["parent_issue_provider", workspace.parentIssue?.provider ?? (workspace.issueKey ? "jira" : null)],
      ["parent_issue_key", workspace.parentIssue?.key ?? workspace.issueKey ?? null],
      ["parent_issue_url", workspace.parentIssue?.url ?? workspace.issueUrl ?? null],
      ["parent_issue_title", workspace.parentIssue?.title ?? workspace.issueTitle ?? null],
      ["parent_issue_status", workspace.parentIssue?.status ?? null],
    ];
    for (const [column, value] of optionalColumns) {
      if (this.hasColumn("workspaces", column)) {
        columns.push(column);
        values.push(value);
      }
    }
    this.database
      .prepare(`INSERT INTO workspaces (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
      .run(...values);
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

  updateWorkspaceParentIssue(workspaceId: string, issue: IssueBinding | null): Workspace | null {
    this.database
      .prepare(
        `UPDATE workspaces
         SET parent_issue_provider = ?, parent_issue_key = ?, parent_issue_url = ?, parent_issue_title = ?,
           parent_issue_status = ?, issue_key = ?, issue_title = ?, issue_url = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        issue?.provider ?? null,
        issue?.key ?? null,
        issue?.url ?? null,
        issue?.title ?? null,
        issue?.status ?? null,
        issue?.key ?? null,
        issue?.title ?? null,
        issue?.url ?? null,
        new Date().toISOString(),
        workspaceId,
      );
    return this.listWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;
  }

  updateWorkspaceLayout(
    workspaceId: string,
    patch: Pick<Workspace, "path"> & { rootPath: string; mode?: Workspace["mode"] },
  ): Workspace | null {
    this.database
      .prepare("UPDATE workspaces SET path = ?, root_path = ?, mode = ?, updated_at = ? WHERE id = ?")
      .run(patch.path, patch.rootPath, patch.mode ?? "freestyle", new Date().toISOString(), workspaceId);
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ?").get(workspaceId);
    return row ? workspaceFromRow(row as Record<string, unknown>) : null;
  }

  archiveWorkspace(workspaceId: string, lifecycle: Workspace["lifecycle"], dirty = false) {
    const now = new Date().toISOString();
    this.database
      .prepare("UPDATE workspaces SET lifecycle = ?, dirty = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(lifecycle, dirty ? 1 : 0, now, now, workspaceId);
  }

  // Hard-delete a workspace row and its workspace sessions. Used when a worktree
  // was actually removed from disk so the (repo_id, name) UNIQUE slot can be
  // reused immediately — archiveWorkspace leaves the row in place and would
  // block recreation under the same name.
  deleteWorkspace(workspaceId: string) {
    this.database.prepare("DELETE FROM workspace_sessions WHERE workspace_id = ?").run(workspaceId);
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

  // Internal — read the auto-recovery dedupe state for a workspace. Used by
  // the auto-recovery monitor; not exposed via the contract Workspace type
  // because operators don't see this directly.
  getWorkspaceAutoRecoveryState(
    workspaceId: string,
  ): { lastCiSha: string | null; lastAttemptAt: string | null } | null {
    const row = this.database
      .prepare(
        "SELECT auto_recovery_last_ci_sha AS lastCiSha, auto_recovery_last_attempt_at AS lastAttemptAt FROM workspaces WHERE id = ?",
      )
      .get(workspaceId) as { lastCiSha: string | null; lastAttemptAt: string | null } | undefined;
    if (!row) return null;
    return { lastCiSha: row.lastCiSha ?? null, lastAttemptAt: row.lastAttemptAt ?? null };
  }

  // Internal — atomic claim of the next auto-recovery slot for a workspace.
  // Returns true iff the row was actually updated. The WHERE clause filters
  // on the same SHA-or-debounce predicate as decideAutoRecoveryAction so a
  // concurrent tick (or a manual same-SHA retry within the debounce window)
  // sees zero affected rows and the caller knows to skip the spawn.
  tryRecordAutoRecoveryAttempt(input: {
    workspaceId: string;
    sha: string;
    now: string;
    debounceCutoff: string;
  }): boolean {
    const result = this.database
      .prepare(
        `UPDATE workspaces
         SET auto_recovery_last_ci_sha = ?, auto_recovery_last_attempt_at = ?
         WHERE id = ?
           AND (auto_recovery_last_ci_sha IS NULL
                OR auto_recovery_last_ci_sha != ?
                OR auto_recovery_last_attempt_at IS NULL
                OR auto_recovery_last_attempt_at < ?)`,
      )
      .run(input.sha, input.now, input.workspaceId, input.sha, input.debounceCutoff);
    return result.changes > 0;
  }

  // Per-workspace PR snapshot — thin wrappers around the free functions in
  // ./workspace-pr-snapshot.ts (extracted to keep this file under the
  // 800-line check:size gate).
  getWorkspacePrSnapshot(workspaceId: string): WorkspacePrSnapshot | null {
    return getWorkspacePrSnapshot(this.database, workspaceId);
  }

  updateWorkspacePrSnapshot(workspaceId: string, patch: Partial<WorkspacePrSnapshot>): void {
    updateWorkspacePrSnapshot(this.database, workspaceId, patch);
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

  listWorkspaceSessions(workspaceId?: string): WorkspaceSession[] {
    const stmt = workspaceId
      ? this.database.prepare("SELECT * FROM workspace_sessions WHERE workspace_id = ? ORDER BY updated_at DESC")
      : this.database.prepare("SELECT * FROM workspace_sessions ORDER BY updated_at DESC");
    const rows = (workspaceId ? stmt.all(workspaceId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(sessionFromRow);
  }

  listSessions(workspaceId?: string): AgentSession[] {
    return this.listWorkspaceSessions(workspaceId).filter(
      (session): session is AgentSession => session.kind === "agent",
    );
  }

  insertWorkspaceSession(session: WorkspaceSessionInput) {
    const kind = session.kind ?? "agent";
    this.database
      .prepare(
        `INSERT INTO workspace_sessions (id, workspace_id, kind, runtime_id, display_name, status, status_reason,
          status_reason_at, target_type, checkout_id, role, action_id, managed, parent_session_id, plan_version_id,
          manager_action_id, closed_at, launch_warnings,
          last_status_at, last_output_at, ended_at, exit_code, transport,
          terminal_backend, tmux_session_name, tmux_session_id, tmux_socket_name,
          pty_session_id, pty_owner_socket, pty_owner_pid, pty_last_seen_at,
          tab_id, runtime_session_id,
          rate_limit_resume_attempts, next_resume_at, last_resume_from_rate_limit_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.workspaceId,
        kind,
        session.runtimeId,
        session.displayName,
        session.status,
        session.statusReason ?? null,
        session.statusReasonAt ?? null,
        session.targetType ?? "worktree_checkout",
        session.checkoutId ?? null,
        session.role ?? null,
        session.actionId ?? null,
        session.managed ? 1 : 0,
        session.parentSessionId ?? null,
        session.planVersionId ?? null,
        session.managerActionId ?? null,
        session.closedAt ?? null,
        JSON.stringify(session.launchWarnings ?? []),
        // Optional in the schema (older test fixtures + out-of-band callers
        // may omit these); the DB layer normalizes to sensible defaults so
        // the column constraints are still satisfied.
        session.lastStatusAt ?? session.updatedAt,
        session.lastOutputAt ?? null,
        session.endedAt ?? null,
        session.exitCode ?? null,
        session.transport,
        session.terminalBackend ?? "tmux",
        session.tmuxSessionName ?? null,
        session.tmuxSessionId ?? null,
        session.tmuxSocketName ?? null,
        session.ptySessionId ?? null,
        session.ptyOwnerSocket ?? null,
        session.ptyOwnerPid ?? null,
        session.ptyLastSeenAt ?? null,
        // Default tab_id to the row id so callers that forget to supply one
        // still get sensible tab ordering (each session becomes its own tab,
        // matching pre-migration behaviour). Restore paths supply the source
        // session's tabId so the restored row reuses the original slot.
        session.tabId ?? session.id,
        session.runtimeSessionId ?? null,
        session.rateLimitResumeAttempts ?? 0,
        session.nextResumeAt ?? null,
        session.lastResumeFromRateLimitAt ?? null,
        session.createdAt,
        session.updatedAt,
      );
  }

  insertSession(session: LegacyAgentSessionInput) {
    this.insertWorkspaceSession(session);
  }

  // Write the runtime-native session UUID onto an existing row. Used by the
  // backfill / Settings-restore flow to link a pre-existing on-disk transcript
  // (e.g. Claude Code's <uuid>.jsonl) to a workspace_session row so the next
  // respawn picks it up via --resume.
  setSessionRuntimeSessionId(sessionId: string, runtimeSessionId: string | null) {
    this.database
      .prepare("UPDATE workspace_sessions SET runtime_session_id = ?, updated_at = ? WHERE id = ?")
      .run(runtimeSessionId, new Date().toISOString(), sessionId);
  }

  updateWorkspaceSessionTerminalOwner(
    sessionId: string,
    update: {
      terminalBackend?: WorkspaceSession["terminalBackend"];
      ptySessionId?: string | null;
      ptyOwnerSocket?: string | null;
      ptyOwnerPid?: number | null;
      ptyLastSeenAt?: string | null;
    },
  ) {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (update.terminalBackend !== undefined) {
      sets.push("terminal_backend = ?");
      values.push(update.terminalBackend);
    }
    if (update.ptySessionId !== undefined) {
      sets.push("pty_session_id = ?");
      values.push(update.ptySessionId);
    }
    if (update.ptyOwnerSocket !== undefined) {
      sets.push("pty_owner_socket = ?");
      values.push(update.ptyOwnerSocket);
    }
    if (update.ptyOwnerPid !== undefined) {
      sets.push("pty_owner_pid = ?");
      values.push(update.ptyOwnerPid);
    }
    if (update.ptyLastSeenAt !== undefined) {
      sets.push("pty_last_seen_at = ?");
      values.push(update.ptyLastSeenAt);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(sessionId);
    this.database.prepare(`UPDATE workspace_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
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
      statusReasonAt?: string | null;
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
    if (update.statusReasonAt !== undefined) {
      sets.push("status_reason_at = ?");
      values.push(update.statusReasonAt);
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
    this.database.prepare(`UPDATE workspace_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  // Partial update for the rate-limit auto-resume bookkeeping. Pass `null`
  // to clear a column; pass `undefined` (omit) to leave it untouched.
  updateSessionRateLimitResume(
    sessionId: string,
    update: {
      rateLimitResumeAttempts?: number;
      nextResumeAt?: string | null;
      lastResumeFromRateLimitAt?: string | null;
    },
  ) {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    if (update.rateLimitResumeAttempts !== undefined) {
      sets.push("rate_limit_resume_attempts = ?");
      values.push(update.rateLimitResumeAttempts);
    }
    if (update.nextResumeAt !== undefined) {
      sets.push("next_resume_at = ?");
      values.push(update.nextResumeAt);
    }
    if (update.lastResumeFromRateLimitAt !== undefined) {
      sets.push("last_resume_from_rate_limit_at = ?");
      values.push(update.lastResumeFromRateLimitAt);
    }
    if (sets.length === 0) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(sessionId);
    this.database.prepare(`UPDATE workspace_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  updateWorkspaceSessionDisplayName(sessionId: string, displayName: string) {
    this.database
      .prepare("UPDATE workspace_sessions SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName, new Date().toISOString(), sessionId);
  }

  updateSessionDisplayName(sessionId: string, displayName: string) {
    this.updateWorkspaceSessionDisplayName(sessionId, displayName);
  }

  deleteWorkspaceSession(sessionId: string) {
    this.database.prepare("DELETE FROM workspace_sessions WHERE id = ?").run(sessionId);
  }

  closeWorkspaceSession(sessionId: string, closedAt = new Date().toISOString()) {
    this.database
      .prepare(
        `UPDATE workspace_sessions
         SET status = 'stopped', status_reason = 'closed_by_user', status_reason_at = ?,
             transport = 'disconnected', tmux_session_name = NULL, tmux_session_id = NULL, tmux_socket_name = NULL,
             pty_session_id = NULL, pty_owner_socket = NULL, pty_owner_pid = NULL, pty_last_seen_at = NULL,
             closed_at = ?, ended_at = COALESCE(ended_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(closedAt, closedAt, closedAt, closedAt, sessionId);
  }

  deleteSession(sessionId: string) {
    this.deleteWorkspaceSession(sessionId);
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

  // Used by the doctor to surface the daemon's current schema_migrations
  // version. Cheap query (single bounded scan); the doctor short-circuits to
  // skipped when the table is missing.
  listSchemaMigrations(): Array<{ version: number; name: string; appliedAt: string }> {
    try {
      const rows = this.database
        .prepare("SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC")
        .all() as Array<{ version: number; name: string; applied_at: string }>;
      return rows.map((r) => ({ version: r.version, name: r.name, appliedAt: r.applied_at }));
    } catch {
      return [];
    }
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

  private ensureColumn(table: string, column: string, definition: string) {
    const cols = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!cols.some((entry) => entry.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      this.columns.delete(table);
    }
  }

  private hasColumn(table: string, column: string) {
    let columns = this.columns.get(table);
    if (!columns) {
      const rows = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      columns = new Set(rows.map((row) => row.name));
      this.columns.set(table, columns);
    }
    return columns.has(column);
  }
}
import { scheduledAgentStoreMethods } from "./scheduled-agent-store.js";
Object.assign(SqliteStore.prototype, scheduledAgentStoreMethods);

// Attach the scheduled_agent_runs and background_sessions methods to
// SqliteStore.prototype. The implementations live in scheduled-run-store.ts
// (kept separate to stay under the per-file line budget); the type
// declarations there augment this class via `declare module`. We can't do
// the assignment inside scheduled-run-store.ts itself because ES module
// hoisting would run it before this class declaration completes.
import { scheduledRunStoreMethods } from "./scheduled-run-store.js";
Object.assign(SqliteStore.prototype, scheduledRunStoreMethods);

import { agentsSystemStoreMethods } from "./agents-system-store.js";
Object.assign(SqliteStore.prototype, agentsSystemStoreMethods);

import { managerOrchestrationStoreMethods } from "./manager-orchestration-store.js";
Object.assign(SqliteStore.prototype, managerOrchestrationStoreMethods);
