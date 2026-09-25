import type { ScheduledAgent } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { scheduledAgentFromRow } from "./rows.js";

const ONE_SHOT_CRON_PLACEHOLDER = "0 0 31 2 *";

declare module "./index.js" {
  interface SqliteStore {
    listScheduledAgents(): ScheduledAgent[];
    findScheduledAgent(id: string): ScheduledAgent | null;
    insertScheduledAgent(agent: ScheduledAgent): void;
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
    ): ScheduledAgent | null;
    recordScheduledAgentRun(
      id: string,
      update: {
        lastRunAt: string;
        lastRunStatus: ScheduledAgent["lastRunStatus"];
        lastRunMessage?: string | null;
        lastWorkspaceId?: string | null;
        lastSessionId?: string | null;
      },
    ): ScheduledAgent | null;
    deleteScheduledAgent(id: string): void;
    resetScheduledAgentRun(id: string): ScheduledAgent | null;
  }
}

export const scheduledAgentStoreMethods = {
  listScheduledAgents(this: SqliteStore): ScheduledAgent[] {
    const rows = this.database.prepare("SELECT * FROM scheduled_agents ORDER BY created_at DESC").all() as Array<
      Record<string, unknown>
    >;
    return rows.map(scheduledAgentFromRow);
  },

  findScheduledAgent(this: SqliteStore, id: string): ScheduledAgent | null {
    const row = this.database.prepare("SELECT * FROM scheduled_agents WHERE id = ?").get(id);
    if (!row) return null;
    return scheduledAgentFromRow(row as Record<string, unknown>);
  },

  insertScheduledAgent(this: SqliteStore, agent: ScheduledAgent) {
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
  },

  updateScheduledAgent(
    this: SqliteStore,
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
  },

  recordScheduledAgentRun(
    this: SqliteStore,
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
  },

  deleteScheduledAgent(this: SqliteStore, id: string) {
    this.database.prepare("DELETE FROM scheduled_agents WHERE id = ?").run(id);
  },

  resetScheduledAgentRun(this: SqliteStore, id: string): ScheduledAgent | null {
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
  },
};
