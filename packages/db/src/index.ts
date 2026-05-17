import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ActivityEvent, AgentSession, Operation, Repo, Workspace } from "@citadel/contracts";

export class SqliteStore {
  readonly databasePath: string;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
  }

  migrate() {
    fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
    this.exec(`
      PRAGMA journal_mode = WAL;
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
        created_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO schema_migrations(version, name, applied_at)
      VALUES (1, 'initial-local-first-schema', datetime('now'));
    `);
  }

  exec(sql: string) {
    execFileSync("sqlite3", [this.databasePath, sql], { encoding: "utf8" });
  }

  query<T>(sql: string): T[] {
    const output = execFileSync("sqlite3", ["-json", this.databasePath, sql], { encoding: "utf8" });
    if (!output.trim()) return [];
    return JSON.parse(output) as T[];
  }

  listRepos(): Repo[] {
    return this.query<Record<string, unknown>>("SELECT * FROM repos WHERE archived_at IS NULL ORDER BY name").map(
      repoFromRow,
    );
  }

  insertRepo(repo: Repo) {
    this.exec(
      `INSERT INTO repos VALUES (${[
        q(repo.id),
        q(repo.name),
        q(repo.rootPath),
        q(repo.defaultBranch),
        q(repo.defaultRemote),
        q(repo.worktreeParent),
        q(JSON.stringify(repo.setupHookIds)),
        q(JSON.stringify(repo.teardownHookIds)),
        q(JSON.stringify(repo.providerIds)),
        q(repo.createdAt),
        q(repo.updatedAt),
        q(repo.archivedAt),
      ].join(",")})`,
    );
  }

  listWorkspaces(repoId?: string): Workspace[] {
    const where = repoId ? `WHERE repo_id = ${q(repoId)} AND archived_at IS NULL` : "WHERE archived_at IS NULL";
    return this.query<Record<string, unknown>>(`SELECT * FROM workspaces ${where} ORDER BY updated_at DESC`).map(
      workspaceFromRow,
    );
  }

  insertWorkspace(workspace: Workspace) {
    this.exec(
      `INSERT INTO workspaces VALUES (${[
        q(workspace.id),
        q(workspace.repoId),
        q(workspace.name),
        q(workspace.path),
        q(workspace.branch),
        q(workspace.baseBranch),
        q(workspace.source),
        q(workspace.prUrl),
        q(workspace.issueKey),
        q(workspace.issueTitle),
        q(workspace.section),
        workspace.pinned ? 1 : 0,
        q(workspace.lifecycle),
        workspace.dirty ? 1 : 0,
        q(workspace.createdAt),
        q(workspace.updatedAt),
        q(workspace.archivedAt),
      ].join(",")})`,
    );
  }

  updateWorkspaceLifecycle(workspaceId: string, lifecycle: Workspace["lifecycle"], dirty = false) {
    this.exec(
      `UPDATE workspaces SET lifecycle = ${q(lifecycle)}, dirty = ${dirty ? 1 : 0}, updated_at = ${q(
        new Date().toISOString(),
      )} WHERE id = ${q(workspaceId)}`,
    );
  }

  archiveWorkspace(workspaceId: string, lifecycle: Workspace["lifecycle"], dirty = false) {
    const now = new Date().toISOString();
    this.exec(
      `UPDATE workspaces SET lifecycle = ${q(lifecycle)}, dirty = ${dirty ? 1 : 0}, archived_at = ${q(now)}, updated_at = ${q(
        now,
      )} WHERE id = ${q(workspaceId)}`,
    );
  }

  listSessions(workspaceId?: string): AgentSession[] {
    const where = workspaceId ? `WHERE workspace_id = ${q(workspaceId)}` : "";
    return this.query<Record<string, unknown>>(`SELECT * FROM agent_sessions ${where} ORDER BY updated_at DESC`).map(
      sessionFromRow,
    );
  }

  insertSession(session: AgentSession) {
    this.exec(
      `INSERT INTO agent_sessions VALUES (${[
        q(session.id),
        q(session.workspaceId),
        q(session.runtimeId),
        q(session.displayName),
        q(session.status),
        q(session.transport),
        q(session.tmuxSessionName),
        q(session.tmuxSessionId),
        q(session.createdAt),
        q(session.updatedAt),
      ].join(",")})`,
    );
  }

  upsertOperation(operation: Operation) {
    this.exec(
      `INSERT OR REPLACE INTO operations VALUES (${[
        q(operation.id),
        q(operation.type),
        q(operation.status),
        q(operation.repoId),
        q(operation.workspaceId),
        operation.progress,
        q(operation.message),
        q(operation.error),
        q(operation.createdAt),
        q(operation.updatedAt),
      ].join(",")})`,
    );
  }

  listOperations(): Operation[] {
    return this.query<Record<string, unknown>>("SELECT * FROM operations ORDER BY updated_at DESC LIMIT 100").map(
      operationFromRow,
    );
  }

  addActivity(event: ActivityEvent) {
    this.exec(
      `INSERT INTO activity_events VALUES (${[
        q(event.id),
        q(event.type),
        q(event.source),
        q(event.repoId),
        q(event.workspaceId),
        q(event.operationId),
        q(event.message),
        q(event.createdAt),
      ].join(",")})`,
    );
  }

  listActivity(workspaceId?: string): ActivityEvent[] {
    const where = workspaceId ? `WHERE workspace_id = ${q(workspaceId)}` : "";
    return this.query<Record<string, unknown>>(
      `SELECT * FROM activity_events ${where} ORDER BY created_at DESC LIMIT 200`,
    ).map(activityFromRow);
  }
}

function q(value: string | null) {
  if (value === null) return "NULL";
  return `'${value.replace(/'/g, "''")}'`;
}

function asString(row: Record<string, unknown>, key: string) {
  return String(row[key] ?? "");
}

function jsonArray(row: Record<string, unknown>, key: string) {
  const raw = asString(row, key);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

function repoFromRow(row: Record<string, unknown>): Repo {
  return {
    id: asString(row, "id"),
    name: asString(row, "name"),
    rootPath: asString(row, "root_path"),
    defaultBranch: asString(row, "default_branch"),
    defaultRemote: asString(row, "default_remote"),
    worktreeParent: asString(row, "worktree_parent"),
    setupHookIds: jsonArray(row, "setup_hook_ids"),
    teardownHookIds: jsonArray(row, "teardown_hook_ids"),
    providerIds: jsonArray(row, "provider_ids"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

function workspaceFromRow(row: Record<string, unknown>): Workspace {
  return {
    id: asString(row, "id"),
    repoId: asString(row, "repo_id"),
    name: asString(row, "name"),
    path: asString(row, "path"),
    branch: asString(row, "branch"),
    baseBranch: asString(row, "base_branch"),
    source: asString(row, "source") as Workspace["source"],
    prUrl: row.pr_url ? asString(row, "pr_url") : null,
    issueKey: row.issue_key ? asString(row, "issue_key") : null,
    issueTitle: row.issue_title ? asString(row, "issue_title") : null,
    section: asString(row, "section"),
    pinned: Number(row.pinned) === 1,
    lifecycle: asString(row, "lifecycle") as Workspace["lifecycle"],
    dirty: Number(row.dirty) === 1,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

function sessionFromRow(row: Record<string, unknown>): AgentSession {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    runtimeId: asString(row, "runtime_id"),
    displayName: asString(row, "display_name"),
    status: asString(row, "status") as AgentSession["status"],
    transport: asString(row, "transport") as AgentSession["transport"],
    tmuxSessionName: row.tmux_session_name ? asString(row, "tmux_session_name") : null,
    tmuxSessionId: row.tmux_session_id ? asString(row, "tmux_session_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function operationFromRow(row: Record<string, unknown>): Operation {
  return {
    id: asString(row, "id"),
    type: asString(row, "type"),
    status: asString(row, "status") as Operation["status"],
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    workspaceId: row.workspace_id ? asString(row, "workspace_id") : null,
    progress: Number(row.progress),
    message: row.message ? asString(row, "message") : null,
    error: row.error ? asString(row, "error") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function activityFromRow(row: Record<string, unknown>): ActivityEvent {
  return {
    id: asString(row, "id"),
    type: asString(row, "type"),
    source: asString(row, "source") as ActivityEvent["source"],
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    workspaceId: row.workspace_id ? asString(row, "workspace_id") : null,
    operationId: row.operation_id ? asString(row, "operation_id") : null,
    message: asString(row, "message"),
    createdAt: asString(row, "created_at"),
  };
}
