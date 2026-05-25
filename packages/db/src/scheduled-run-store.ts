import type { BackgroundAgentSession, ScheduledAgentRun } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { backgroundSessionFromRow, scheduledAgentRunFromRow } from "./rows.js";

// Module-augment SqliteStore so callers can use these methods like any other
// store method. `index.ts` calls `Object.assign(SqliteStore.prototype,
// scheduledRunStoreMethods)` at runtime — importing SqliteStore at module-
// load time here would deadlock (ES module hoisting: this file runs before
// the class declaration body in index.ts).
declare module "./index.js" {
  interface SqliteStore {
    insertScheduledAgentRun(run: ScheduledAgentRun): void;
    findScheduledAgentRun(id: string): ScheduledAgentRun | null;
    listScheduledAgentRuns(
      scheduledAgentId: string,
      options?: { limit?: number; offset?: number },
    ): ScheduledAgentRun[];
    findInFlightScheduledAgentRun(scheduledAgentId: string): ScheduledAgentRun | null;
    listInFlightScheduledAgentRuns(): ScheduledAgentRun[];
    countQueuedScheduledAgentRuns(scheduledAgentId: string): number;
    findOldestQueuedScheduledAgentRun(scheduledAgentId: string): ScheduledAgentRun | null;
    promoteScheduledAgentRunToRunning(
      id: string,
      update: { startedAt: string; logFilePath: string },
    ): ScheduledAgentRun | null;
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
    ): ScheduledAgentRun | null;
    insertBackgroundSession(session: BackgroundAgentSession): void;
    findBackgroundSession(id: string): BackgroundAgentSession | null;
    findBackgroundSessionsByScheduledAgent(scheduledAgentId: string): BackgroundAgentSession[];
    listRunningBackgroundSessions(): BackgroundAgentSession[];
    updateBackgroundSessionStatus(id: string, status: BackgroundAgentSession["status"]): BackgroundAgentSession | null;
    deleteBackgroundSession(id: string): void;
    deleteScheduledAgentCascade(id: string): { logFilePaths: string[]; tmuxSessionNames: string[] } | null;
  }
}

export const scheduledRunStoreMethods = {
  insertScheduledAgentRun(this: SqliteStore, run: ScheduledAgentRun) {
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
  },
  findScheduledAgentRun(this: SqliteStore, id: string): ScheduledAgentRun | null {
    const row = this.database.prepare("SELECT * FROM scheduled_agent_runs WHERE id = ?").get(id);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  },
  listScheduledAgentRuns(
    this: SqliteStore,
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
  },
  findInFlightScheduledAgentRun(this: SqliteStore, scheduledAgentId: string): ScheduledAgentRun | null {
    const row = this.database
      .prepare(
        `SELECT * FROM scheduled_agent_runs
         WHERE scheduled_agent_id = ? AND status = 'running'
         ORDER BY enqueued_at DESC LIMIT 1`,
      )
      .get(scheduledAgentId);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  },
  listInFlightScheduledAgentRuns(this: SqliteStore): ScheduledAgentRun[] {
    const rows = this.database
      .prepare("SELECT * FROM scheduled_agent_runs WHERE status = 'running' ORDER BY enqueued_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(scheduledAgentRunFromRow);
  },
  countQueuedScheduledAgentRuns(this: SqliteStore, scheduledAgentId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS n FROM scheduled_agent_runs WHERE scheduled_agent_id = ? AND status = 'queued'")
      .get(scheduledAgentId) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  },
  findOldestQueuedScheduledAgentRun(this: SqliteStore, scheduledAgentId: string): ScheduledAgentRun | null {
    const row = this.database
      .prepare(
        `SELECT * FROM scheduled_agent_runs
         WHERE scheduled_agent_id = ? AND status = 'queued'
         ORDER BY enqueued_at ASC, id ASC LIMIT 1`,
      )
      .get(scheduledAgentId);
    if (!row) return null;
    return scheduledAgentRunFromRow(row as Record<string, unknown>);
  },
  promoteScheduledAgentRunToRunning(
    this: SqliteStore,
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
  },
  recordScheduledAgentRunOutcome(
    this: SqliteStore,
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
  },
  insertBackgroundSession(this: SqliteStore, session: BackgroundAgentSession) {
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
  },
  findBackgroundSession(this: SqliteStore, id: string): BackgroundAgentSession | null {
    const row = this.database.prepare("SELECT * FROM background_sessions WHERE id = ?").get(id);
    if (!row) return null;
    return backgroundSessionFromRow(row as Record<string, unknown>);
  },
  findBackgroundSessionsByScheduledAgent(this: SqliteStore, scheduledAgentId: string): BackgroundAgentSession[] {
    const rows = this.database
      .prepare("SELECT * FROM background_sessions WHERE scheduled_agent_id = ? ORDER BY created_at DESC")
      .all(scheduledAgentId) as Array<Record<string, unknown>>;
    return rows.map(backgroundSessionFromRow);
  },
  listRunningBackgroundSessions(this: SqliteStore): BackgroundAgentSession[] {
    const rows = this.database
      .prepare("SELECT * FROM background_sessions WHERE status = 'running' ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;
    return rows.map(backgroundSessionFromRow);
  },
  updateBackgroundSessionStatus(
    this: SqliteStore,
    id: string,
    status: BackgroundAgentSession["status"],
  ): BackgroundAgentSession | null {
    const updatedAt = new Date().toISOString();
    this.database
      .prepare("UPDATE background_sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    return this.findBackgroundSession(id);
  },
  deleteBackgroundSession(this: SqliteStore, id: string) {
    this.database.prepare("DELETE FROM background_sessions WHERE id = ?").run(id);
  },
  // Cascade delete: returns the cleanup metadata (log paths + tmux session
  // names) the operations layer needs to perform fs/tmux cleanup. The DB-side
  // delete runs in one transaction so the data side never races a concurrent
  // reader. Caller is responsible for the side-effecting cleanup.
  deleteScheduledAgentCascade(
    this: SqliteStore,
    id: string,
  ): { logFilePaths: string[]; tmuxSessionNames: string[] } | null {
    const existing = this.findScheduledAgent(id);
    if (!existing) return null;
    const runs = this.listScheduledAgentRuns(id, { limit: 500 });
    const bgSessions = this.findBackgroundSessionsByScheduledAgent(id);
    const logFilePaths = runs
      .map((run: ScheduledAgentRun) => run.logFilePath)
      .filter((path: string | null): path is string => typeof path === "string" && path.length > 0);
    const tmuxSessionNames = bgSessions.map((row: BackgroundAgentSession) => row.tmuxSessionName);
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
  },
};
