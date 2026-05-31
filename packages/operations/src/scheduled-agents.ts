import fs from "node:fs";
import path from "node:path";
import type { AgentRuntimeConfig } from "@citadel/config";
import type {
  BackgroundAgentSession,
  CreateScheduledAgentInput,
  ScheduledAgent,
  ScheduledAgentRun,
  UpdateScheduledAgentInput,
  Workspace,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "./index.js";

export type ScheduledAgentRunResult = {
  agent: ScheduledAgent;
  status: "succeeded" | "failed";
  message: string;
  workspaceId: string | null;
  sessionId: string | null;
  backgroundSessionId: string | null;
  runId: string;
};

/**
 * Caller-visible result of a manual runNow request. Mirrors the HTTP/MCP
 * response shape so HTTP routes and MCP handlers can map it 1:1.
 */
export type ManualRunResult =
  | {
      kind: "ran";
      runId: string;
      status: "succeeded" | "failed";
      message: string;
      workspaceId: string | null;
      sessionId: string | null;
      backgroundSessionId: string | null;
    }
  | { kind: "queued"; runId: string; queuePosition: number }
  | { kind: "skipped_overlap" }
  | { kind: "queue_full"; limit: number };

/** Bound on the per-agent queue. Beyond this, queue-policy fires fall back to skip. */
export const MAX_QUEUED_RUNS_PER_AGENT = 10;

/** Filesystem-backed log file naming under dataDir. */
function buildLogFilePath(dataDir: string, scheduledAgentId: string, runId: string): string {
  return path.join(dataDir, "scheduled-runs", scheduledAgentId, `${runId}.log`);
}

/** Side-effect: ensure the parent dir of the run's log file exists. */
function ensureLogParentDir(logFilePath: string) {
  fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
}

/** Background-session creator deps — injected so the operations package can keep
 *  the tmux + ttyd integration in a sibling module. The runner is happy to call
 *  through this interface for testability. */
export type BackgroundSessionCreator = (input: {
  cwd: string;
  runtimeId: string;
  runtime: {
    command: string;
    args: string[];
    displayName: string;
    promptArg: string | null;
    sessionIdArg?: string | null;
    resumeArg?: string | null;
  };
  prompt?: string;
  scheduledAgentId: string;
  logFilePath: string;
}) => Promise<BackgroundAgentSession>;

// Cron parser, matcher, and describer live in ./cron.js. Re-exported here so
// existing callers keep working without touching imports.
import { type CronExpression, cronMatches, floorToMinute, parseCronExpression } from "./cron.js";
export { parseCronExpression, cronMatches, nextCronRun, describeCron } from "./cron.js";
export type { CronExpression } from "./cron.js";

function formatRunStamp(date: Date) {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join("");
}

export type ScheduledAgentDeps = {
  store: SqliteStore;
  operations: OperationService;
  getRuntime: (runtimeId: string) => AgentRuntimeConfig | undefined;
  /** Absolute path where per-run log files live (`<dataDir>/scheduled-runs/...`). */
  dataDir: string;
  /** Injected so the runner doesn't import tmux/terminal. Step 4 wires this in. */
  createBackgroundSession?: BackgroundSessionCreator;
  /** Best-effort cleanup hooks invoked by the cascade-on-delete path. */
  killTmuxSession?: (sessionName: string) => void;
  recordActivity?: (event: {
    type: string;
    message: string;
    repoId: string | null;
    workspaceId: string | null;
  }) => void;
  /** SSE-style emit for per-row events. Fired on row insert and on terminal transition. */
  emitRunRow?: (event: { scheduledAgentId: string; runId: string; status: ScheduledAgentRun["status"] }) => void;
};

export class ScheduledAgentRunner {
  constructor(private readonly deps: ScheduledAgentDeps) {}

  list(): ScheduledAgent[] {
    return this.deps.store.listScheduledAgents();
  }

  find(id: string): ScheduledAgent | null {
    return this.deps.store.findScheduledAgent(id);
  }

  create(input: CreateScheduledAgentInput): ScheduledAgent {
    const scheduleType: ScheduledAgent["scheduleType"] = input.scheduleType ?? "recurring";
    let cron: string | null = null;
    let runAt: string | null = null;
    if (scheduleType === "recurring") {
      if (!input.cron) throw new Error("cron is required for recurring schedules");
      parseCronExpression(input.cron);
      cron = input.cron;
    } else {
      if (!input.runAt) throw new Error("runAt is required for one-shot schedules");
      const parsed = new Date(input.runAt);
      if (Number.isNaN(parsed.getTime())) throw new Error("runAt must be a valid ISO timestamp");
      runAt = parsed.toISOString();
    }
    this.assertRepoAndRuntime(input.repoId, input.runtimeId);
    const now = nowIso();
    const agent: ScheduledAgent = {
      id: createId("sched"),
      name: input.name,
      description: input.description ?? null,
      scheduleType,
      cron,
      runAt,
      repoId: input.repoId,
      runtimeId: input.runtimeId,
      prompt: input.prompt ?? null,
      // For background runs the workspace fields are unused at fire time but
      // the entity schema still requires non-empty values. Default to safe
      // placeholders so the contract stays satisfied without the UI faking
      // input. resolveWorkspace skips them via the runMode branch.
      workspaceStrategy: input.workspaceStrategy ?? "new",
      workspaceName: input.workspaceName ?? "(background)",
      baseBranch: input.baseBranch ?? null,
      runMode: input.runMode ?? "workspace",
      backgroundCwd: input.backgroundCwd ?? null,
      overlapPolicy: input.overlapPolicy ?? "skip",
      enabled: input.enabled ?? true,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunMessage: null,
      lastWorkspaceId: null,
      lastSessionId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.store.insertScheduledAgent(agent);
    this.deps.recordActivity?.({
      type: "scheduled-agent.created",
      message:
        scheduleType === "recurring"
          ? `Scheduled agent ${agent.name} (${agent.cron})`
          : `Scheduled agent ${agent.name} (once at ${agent.runAt})`,
      repoId: agent.repoId,
      workspaceId: null,
    });
    return agent;
  }

  update(id: string, input: UpdateScheduledAgentInput): ScheduledAgent | null {
    const existing = this.deps.store.findScheduledAgent(id);
    if (!existing) return null;
    const nextScheduleType = input.scheduleType ?? existing.scheduleType;
    if (input.cron !== undefined && input.cron !== null) parseCronExpression(input.cron);
    if (nextScheduleType === "recurring") {
      const effectiveCron = input.cron !== undefined ? input.cron : existing.cron;
      if (!effectiveCron) throw new Error("cron is required for recurring schedules");
    }
    if (nextScheduleType === "once") {
      const effectiveRunAt = input.runAt !== undefined ? input.runAt : existing.runAt;
      if (!effectiveRunAt) throw new Error("runAt is required for one-shot schedules");
      const parsed = new Date(effectiveRunAt);
      if (Number.isNaN(parsed.getTime())) throw new Error("runAt must be a valid ISO timestamp");
    }
    if (input.repoId || input.runtimeId) {
      this.assertRepoAndRuntime(input.repoId ?? existing.repoId, input.runtimeId ?? existing.runtimeId);
    }
    const patch: Parameters<SqliteStore["updateScheduledAgent"]>[1] = {};
    if (input.name !== undefined) patch.name = input.name;
    if (input.description !== undefined) patch.description = input.description ?? null;
    if (input.scheduleType !== undefined) patch.scheduleType = input.scheduleType;
    if (input.cron !== undefined) patch.cron = input.cron;
    if (input.runAt !== undefined) patch.runAt = input.runAt ?? null;
    if (input.repoId !== undefined) patch.repoId = input.repoId;
    if (input.runtimeId !== undefined) patch.runtimeId = input.runtimeId;
    if (input.prompt !== undefined) patch.prompt = input.prompt ?? null;
    if (input.workspaceStrategy !== undefined) patch.workspaceStrategy = input.workspaceStrategy;
    if (input.workspaceName !== undefined) patch.workspaceName = input.workspaceName;
    if (input.baseBranch !== undefined) patch.baseBranch = input.baseBranch ?? null;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    // When switching to recurring, drop the stored runAt so it doesn't get
    // re-applied if the user toggles back. Same for cron when switching to once.
    if (input.scheduleType === "recurring" && input.runAt === undefined) patch.runAt = null;
    if (input.scheduleType === "once" && input.cron === undefined) patch.cron = null;
    // Re-arm: if the user changes the schedule definition (cron / runAt /
    // scheduleType) the previous run is no longer "the latest" — reset
    // lastRunStatus so the tick guard treats the agent as un-fired. Without
    // this a one-shot that succeeded can never be PATCHed with a new runAt.
    const scheduleChanged = input.cron !== undefined || input.runAt !== undefined || input.scheduleType !== undefined;
    const updated = this.deps.store.updateScheduledAgent(id, patch);
    if (!updated || !scheduleChanged) return updated;
    return this.deps.store.resetScheduledAgentRun(id);
  }

  /**
   * Delete a scheduled agent with cascade. Returns a typed error if a run is
   * currently in flight (HTTP DELETE maps to 409 in_flight_run; MCP returns
   * the same shape). On success, performs the side-effecting cleanup
   * (fs.unlink on log files, tmux kill-session on background panes) AFTER
   * the DB transaction commits.
   */
  delete(id: string): { ok: true } | { ok: false; error: "scheduled_agent_not_found" | "in_flight_run" } {
    const existing = this.deps.store.findScheduledAgent(id);
    if (!existing) return { ok: false, error: "scheduled_agent_not_found" };
    if (this.deps.store.findInFlightScheduledAgentRun(id)) return { ok: false, error: "in_flight_run" };
    const cleanup = this.deps.store.deleteScheduledAgentCascade(id);
    if (!cleanup) return { ok: false, error: "scheduled_agent_not_found" };
    for (const logPath of cleanup.logFilePaths) {
      try {
        fs.unlinkSync(logPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
          // best-effort: a log we can't delete is leaked, not corrupting
        }
      }
    }
    for (const tmuxName of cleanup.tmuxSessionNames) {
      try {
        this.deps.killTmuxSession?.(tmuxName);
      } catch {
        // best-effort: tmux may already be gone
      }
    }
    this.deps.recordActivity?.({
      type: "scheduled-agent.deleted",
      message: `Deleted scheduled agent ${existing.name}`,
      repoId: existing.repoId,
      workspaceId: null,
    });
    return { ok: true };
  }

  /**
   * Recurring + one-shot tick. Decides per-agent whether to fire, queue, or
   * skip based on overlapPolicy and any in-flight run.
   * Returns the agent IDs that fired synchronously (queued enqueues are NOT
   * counted as fired — they fire later via drain).
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    const minuteFloor = floorToMinute(now);
    const fired: string[] = [];
    for (const agent of this.deps.store.listScheduledAgents()) {
      if (!agent.enabled) continue;
      // Pre-check: scheduleType-specific eligibility.
      if (agent.scheduleType === "once") {
        if (!agent.runAt) continue;
        const runAt = new Date(agent.runAt).getTime();
        if (Number.isNaN(runAt) || runAt > now.getTime()) continue;
        // Anything past 'never' means the row already fired (or is mid-flight).
        // Defense in depth: the in-flight + auto-disable below catches the rest.
        if (agent.lastRunStatus !== "never") continue;
      } else {
        if (!agent.cron) continue;
        let expr: CronExpression;
        try {
          expr = parseCronExpression(agent.cron);
        } catch {
          continue;
        }
        if (!cronMatches(expr, minuteFloor)) continue;
        const lastRunMinute = agent.lastRunAt ? floorToMinute(new Date(agent.lastRunAt)).getTime() : 0;
        if (lastRunMinute >= minuteFloor.getTime()) continue;
      }

      // Overlap decision.
      const inFlight = this.deps.store.findInFlightScheduledAgentRun(agent.id);
      if (inFlight) {
        if (agent.overlapPolicy === "queue") {
          if (this.deps.store.countQueuedScheduledAgentRuns(agent.id) >= MAX_QUEUED_RUNS_PER_AGENT) {
            this.deps.recordActivity?.({
              type: "scheduled-agent.queue_full",
              message: `${agent.name}: queue full (${MAX_QUEUED_RUNS_PER_AGENT}); dropped`,
              repoId: agent.repoId,
              workspaceId: null,
            });
            continue;
          }
          this.enqueueRunRow(agent, now);
          this.deps.recordActivity?.({
            type: "scheduled-agent.queued",
            message: `${agent.name}: previous run still in flight; queued`,
            repoId: agent.repoId,
            workspaceId: null,
          });
        } else {
          this.deps.recordActivity?.({
            type: "scheduled-agent.skipped_overlap",
            message: `${agent.name}: previous run still in flight; skipped`,
            repoId: agent.repoId,
            workspaceId: null,
          });
        }
        continue;
      }

      // No in-flight: enqueue + promote + execute synchronously.
      // For one-shots, also disable BEFORE awaiting so a slow execute() can't
      // be picked up by the next tick (belt-and-suspenders alongside the
      // in-flight check).
      if (agent.scheduleType === "once") {
        this.deps.store.updateScheduledAgent(agent.id, { enabled: false });
      }
      try {
        await this.fireImmediately(agent, now);
      } finally {
        fired.push(agent.id);
      }
    }
    return fired;
  }

  /**
   * Manual "Run now". Returns a typed envelope reflecting the four possible
   * outcomes: ran-synchronously / queued / skipped (in-flight + skip policy)
   * / queue_full.
   */
  async runNow(id: string, now: Date = new Date()): Promise<ManualRunResult> {
    const agent = this.deps.store.findScheduledAgent(id);
    if (!agent) throw new Error(`Unknown scheduled agent: ${id}`);
    const inFlight = this.deps.store.findInFlightScheduledAgentRun(id);
    if (inFlight) {
      if (agent.overlapPolicy === "queue") {
        const queueCount = this.deps.store.countQueuedScheduledAgentRuns(id);
        if (queueCount >= MAX_QUEUED_RUNS_PER_AGENT) {
          return { kind: "queue_full", limit: MAX_QUEUED_RUNS_PER_AGENT };
        }
        const queued = this.enqueueRunRow(agent, now);
        return { kind: "queued", runId: queued.id, queuePosition: queueCount + 1 };
      }
      return { kind: "skipped_overlap" };
    }
    const result = await this.fireImmediately(agent, now);
    return {
      kind: "ran",
      runId: result.runId,
      status: result.status,
      message: result.message,
      workspaceId: result.workspaceId,
      sessionId: result.sessionId,
      backgroundSessionId: result.backgroundSessionId,
    };
  }

  /**
   * Boot-sweep called once at daemon startup. Closes any orphaned 'running'
   * rows from before the crash, syncs the denormalized lastRunStatus cache on
   * each affected agent, kills + deletes any dangling background_sessions row,
   * and drains any queued rows that were waiting on those orphans.
   */
  async recoverInFlightRuns(now: Date = new Date()): Promise<void> {
    const inFlight = this.deps.store.listInFlightScheduledAgentRuns();
    const affectedAgentIds = new Set<string>();
    for (const row of inFlight) {
      this.deps.store.recordScheduledAgentRunOutcome(row.id, {
        status: "failed",
        endedAt: now.toISOString(),
        message: "daemon_restarted_during_run",
      });
      this.deps.emitRunRow?.({ scheduledAgentId: row.scheduledAgentId, runId: row.id, status: "failed" });
      // Update the denormalized cache if this is the most-recent run.
      const latest = this.deps.store.listScheduledAgentRuns(row.scheduledAgentId, { limit: 1 })[0];
      if (latest && latest.id === row.id) {
        this.deps.store.recordScheduledAgentRun(row.scheduledAgentId, {
          lastRunAt: now.toISOString(),
          lastRunStatus: "failed",
          lastRunMessage: "daemon_restarted_during_run",
        });
      }
      // Clean up the matching background session (if any).
      if (row.backgroundSessionId) {
        const bg = this.deps.store.findBackgroundSession(row.backgroundSessionId);
        if (bg) {
          try {
            this.deps.killTmuxSession?.(bg.tmuxSessionName);
          } catch {
            // best-effort
          }
          this.deps.store.deleteBackgroundSession(bg.id);
        }
      }
      affectedAgentIds.add(row.scheduledAgentId);
    }
    for (const agentId of affectedAgentIds) {
      await this.drainQueue(agentId, now);
    }
  }

  /**
   * Promote the oldest queued row for an agent (if any) and execute it.
   * Idempotent — concurrent calls all early-return if a run is already in
   * flight because findInFlightScheduledAgentRun gates execution.
   */
  async drainQueue(scheduledAgentId: string, now: Date = new Date()): Promise<void> {
    if (this.deps.store.findInFlightScheduledAgentRun(scheduledAgentId)) return;
    const queued = this.deps.store.findOldestQueuedScheduledAgentRun(scheduledAgentId);
    if (!queued) return;
    const agent = this.deps.store.findScheduledAgent(scheduledAgentId);
    if (!agent) return;
    const logFilePath = buildLogFilePath(this.deps.dataDir, agent.id, queued.id);
    ensureLogParentDir(logFilePath);
    this.deps.store.promoteScheduledAgentRunToRunning(queued.id, {
      startedAt: now.toISOString(),
      logFilePath,
    });
    this.deps.emitRunRow?.({ scheduledAgentId: agent.id, runId: queued.id, status: "running" });
    await this.executeRun(agent, queued.id, logFilePath, now);
  }

  // ────────────────────────────────────────────────────────────────────────
  // internals

  /** Insert a queued run row at fire time. */
  private enqueueRunRow(agent: ScheduledAgent, now: Date): ScheduledAgentRun {
    const run: ScheduledAgentRun = {
      id: createId("run"),
      scheduledAgentId: agent.id,
      status: "queued",
      enqueuedAt: now.toISOString(),
      startedAt: null,
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    };
    this.deps.store.insertScheduledAgentRun(run);
    this.deps.emitRunRow?.({ scheduledAgentId: agent.id, runId: run.id, status: "queued" });
    return run;
  }

  /** Enqueue + promote + execute synchronously. Used by tick and manual runNow when no run is in flight. */
  private async fireImmediately(agent: ScheduledAgent, now: Date): Promise<ScheduledAgentRunResult> {
    const queued = this.enqueueRunRow(agent, now);
    const logFilePath = buildLogFilePath(this.deps.dataDir, agent.id, queued.id);
    ensureLogParentDir(logFilePath);
    this.deps.store.promoteScheduledAgentRunToRunning(queued.id, {
      startedAt: now.toISOString(),
      logFilePath,
    });
    this.deps.emitRunRow?.({ scheduledAgentId: agent.id, runId: queued.id, status: "running" });
    // Mirror the denormalized cache too — readers of the agent's lastRunStatus
    // see the run as "running" immediately, not just on outcome.
    this.deps.store.recordScheduledAgentRun(agent.id, {
      lastRunAt: now.toISOString(),
      lastRunStatus: "running",
      lastRunMessage: "Run starting",
    });
    return this.executeRun(agent, queued.id, logFilePath, now);
  }

  /**
   * Execute a run that's already been promoted to 'running' (run row + log
   * dir exist). Records the outcome and drains the queue afterward.
   */
  private async executeRun(
    agent: ScheduledAgent,
    runId: string,
    logFilePath: string,
    now: Date,
  ): Promise<ScheduledAgentRunResult> {
    const result = await this.execute(agent, runId, logFilePath, now);
    // Record outcome on the run row, and surface log_truncated_at_16mib via
    // a fs.statSync size check (the head -c cap is bounded by the same
    // constant in @citadel/terminal; we read the file size here to detect).
    let outcomeMessage = result.message;
    try {
      const stat = fs.statSync(logFilePath);
      if (stat.size >= LOG_TRUNCATION_BYTES) {
        outcomeMessage = `${result.message} (log_truncated_at_16mib)`;
      }
    } catch (error) {
      // Workspace-mode runs never create a log file at this path, so ENOENT
      // is the expected case. Anything else (permission errors, IO failures)
      // is unexpected and should not silently strip the truncation marker.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.warn("[citadel] scheduled-agent run log stat failed:", error);
      }
    }
    this.deps.store.recordScheduledAgentRunOutcome(runId, {
      status: result.status,
      endedAt: nowIso(),
      message: outcomeMessage,
      workspaceId: result.workspaceId,
      sessionId: result.sessionId,
      backgroundSessionId: result.backgroundSessionId,
    });
    this.deps.emitRunRow?.({ scheduledAgentId: agent.id, runId, status: result.status });
    this.deps.store.recordScheduledAgentRun(agent.id, {
      lastRunAt: now.toISOString(),
      lastRunStatus: result.status,
      lastRunMessage: outcomeMessage,
      lastWorkspaceId: result.workspaceId,
      lastSessionId: result.sessionId,
    });
    this.deps.recordActivity?.({
      type: `scheduled-agent.${result.status}`,
      message: `${agent.name}: ${outcomeMessage}`,
      repoId: agent.repoId,
      workspaceId: result.workspaceId,
    });
    // Fire-and-forget drain so we don't hold the caller waiting.
    void this.drainQueue(agent.id).catch(() => {
      /* best-effort */
    });
    return { ...result, message: outcomeMessage };
  }

  private async execute(
    agent: ScheduledAgent,
    runId: string,
    logFilePath: string,
    now: Date,
  ): Promise<ScheduledAgentRunResult> {
    const repo = this.deps.store.listRepos().find((candidate) => candidate.id === agent.repoId);
    if (!repo) return runFailure(agent, runId, "Repository is no longer tracked");
    const runtime = this.deps.getRuntime(agent.runtimeId);
    if (!runtime) return runFailure(agent, runId, `Runtime ${agent.runtimeId} is not configured`);

    if (agent.runMode === "background") {
      const cwd = agent.backgroundCwd ?? repo.rootPath;
      try {
        const stat = fs.statSync(cwd);
        if (!stat.isDirectory()) return runFailure(agent, runId, "background_cwd_missing");
      } catch {
        return runFailure(agent, runId, "background_cwd_missing");
      }
      if (!this.deps.createBackgroundSession) {
        return runFailure(agent, runId, "background_session_creator_unavailable");
      }
      try {
        const session = await this.deps.createBackgroundSession({
          cwd,
          runtimeId: agent.runtimeId,
          runtime: {
            command: runtime.command,
            args: runtime.args,
            displayName: runtime.displayName,
            promptArg: runtime.promptArg ?? null,
          },
          ...(agent.prompt ? { prompt: agent.prompt } : {}),
          scheduledAgentId: agent.id,
          logFilePath,
        });
        return {
          agent,
          runId,
          status: "succeeded",
          message: `Started ${runtime.displayName} (background) in ${cwd}`,
          workspaceId: null,
          sessionId: null,
          backgroundSessionId: session.id,
        };
      } catch (error) {
        return runFailure(agent, runId, error instanceof Error ? error.message : "background_session_failed");
      }
    }

    // workspace runMode — unchanged path.
    let workspace: Workspace | undefined;
    try {
      workspace = await this.resolveWorkspace(agent, now);
    } catch (error) {
      return runFailure(agent, runId, error instanceof Error ? error.message : "workspace_resolution_failed");
    }
    if (!workspace) return runFailure(agent, runId, "Workspace could not be created");
    if (workspace.lifecycle === "failed") return runFailure(agent, runId, "Workspace creation failed", workspace.id);

    try {
      const session = await this.deps.operations.createAgentSession(
        {
          workspaceId: workspace.id,
          runtimeId: agent.runtimeId,
          displayName: `${agent.name} (scheduled)`,
          ...(agent.prompt ? { prompt: agent.prompt } : {}),
        },
        {
          command: runtime.command,
          args: runtime.args,
          displayName: runtime.displayName,
          promptArg: runtime.promptArg ?? null,
          sessionIdArg: runtime.sessionIdArg ?? null,
          resumeArg: runtime.resumeArg ?? null,
        },
      );
      return {
        agent,
        runId,
        status: "succeeded",
        message: `Started ${runtime.displayName} in ${workspace.name}`,
        workspaceId: workspace.id,
        sessionId: session.id,
        backgroundSessionId: null,
      };
    } catch (error) {
      return runFailure(agent, runId, error instanceof Error ? error.message : "session_start_failed", workspace.id);
    }
  }

  private async resolveWorkspace(agent: ScheduledAgent, now: Date): Promise<Workspace | undefined> {
    const repoWorkspaces = this.deps.store.listWorkspaces(agent.repoId);
    if (agent.workspaceStrategy === "existing") {
      const existing = repoWorkspaces.find(
        (candidate) => candidate.name === agent.workspaceName && !candidate.archivedAt,
      );
      if (existing) return existing;
      return this.createScheduledWorkspace(agent, agent.workspaceName);
    }
    const stamp = formatRunStamp(now);
    const name = `${agent.workspaceName}-${stamp}`;
    return this.createScheduledWorkspace(agent, name);
  }

  private async createScheduledWorkspace(agent: ScheduledAgent, name: string): Promise<Workspace | undefined> {
    const result = await this.deps.operations.createWorkspace({
      repoId: agent.repoId,
      name,
      source: "scratch",
      ...(agent.baseBranch ? { baseBranch: agent.baseBranch } : {}),
    });
    return this.deps.store.listWorkspaces().find((candidate) => candidate.id === result.workspaceId);
  }

  private assertRepoAndRuntime(repoId: string, runtimeId: string) {
    const repo = this.deps.store.listRepos().find((candidate) => candidate.id === repoId);
    if (!repo) throw new Error(`Unknown repo: ${repoId}`);
    const runtime = this.deps.getRuntime(runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${runtimeId}`);
  }
}

function runFailure(
  agent: ScheduledAgent,
  runId: string,
  message: string,
  workspaceId: string | null = null,
): ScheduledAgentRunResult {
  return { agent, runId, status: "failed", message, workspaceId, sessionId: null, backgroundSessionId: null };
}

/** Must match LOG_TRUNCATION_BYTES in @citadel/terminal (set in step 4). */
const LOG_TRUNCATION_BYTES = 16 * 1024 * 1024;
