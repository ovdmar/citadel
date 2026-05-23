import type { RuntimeConfig } from "@citadel/config";
import type {
  CreateScheduledAgentInput,
  ScheduledAgent,
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
};

export type CronExpression = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
};

const CRON_BOUNDS: ReadonlyArray<{ min: number; max: number }> = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export function parseCronExpression(spec: string): CronExpression {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields, got ${parts.length}`);
  const fields = parts.map((part, index) => {
    const bounds = CRON_BOUNDS[index];
    if (!bounds) throw new Error("Unexpected cron field");
    return parseCronField(part, bounds.min, bounds.max);
  });
  const [minute, hour, dom, mon, dow] = fields;
  if (!minute || !hour || !dom || !mon || !dow) throw new Error("Failed to parse cron fields");
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    mon: mon.values,
    dow: dow.values,
    domWild: dom.wild,
    dowWild: dow.wild,
  };
}

function parseCronField(spec: string, min: number, max: number): { values: Set<number>; wild: boolean } {
  if (!spec.length) throw new Error("Empty cron field");
  let wild = false;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    let body = part;
    let step = 1;
    const stepMatch = body.match(/^(.*)\/(\d+)$/);
    if (stepMatch?.[1] !== undefined && stepMatch[2] !== undefined) {
      body = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) throw new Error(`Invalid cron step in '${part}'`);
    }
    let lo: number;
    let hi: number;
    if (body === "*" || body === "") {
      lo = min;
      hi = max;
      if (spec === "*") wild = true;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number.parseInt(a ?? "", 10);
      hi = Number.parseInt(b ?? "", 10);
    } else {
      lo = Number.parseInt(body, 10);
      hi = lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`Invalid cron number in '${part}'`);
    if (lo < min || hi > max || lo > hi) throw new Error(`Cron value '${part}' out of range [${min}, ${max}]`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) throw new Error("Cron field produced no values");
  return { values, wild };
}

export function cronMatches(expr: CronExpression, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!expr.minute.has(minute) || !expr.hour.has(hour) || !expr.mon.has(mon)) return false;
  if (expr.domWild && expr.dowWild) return true;
  if (expr.domWild) return expr.dow.has(dow);
  if (expr.dowWild) return expr.dom.has(dom);
  return expr.dom.has(dom) || expr.dow.has(dow);
}

function floorToMinute(date: Date) {
  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

/**
 * Return the next datetime (>= `from`, exclusive of `from` if seconds==0) at which
 * `spec` will fire. Walks forward minute-by-minute but skips ahead when the month
 * or day-of-month/week clearly cannot match — bounded to one year ahead so a
 * pathological cron returns null instead of looping forever.
 */
export function nextCronRun(spec: string, from: Date = new Date()): Date | null {
  let expr: CronExpression;
  try {
    expr = parseCronExpression(spec);
  } catch {
    return null;
  }
  const start = floorToMinute(from);
  // Walk forward by one minute at a time. Bounded to 366 days so we never spin.
  const limit = new Date(start.getTime() + 366 * 24 * 60 * 60 * 1000);
  const cursor = new Date(start.getTime() + 60_000);
  while (cursor.getTime() <= limit.getTime()) {
    if (cronMatches(expr, cursor)) return cursor;
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

/**
 * Plain-English summary of a five-field cron expression. Falls back to the
 * raw spec when the pattern isn't a known preset so the UI never lies about
 * unusual schedules.
 */
export function describeCron(spec: string): string {
  const trimmed = spec.trim();
  let expr: CronExpression;
  try {
    expr = parseCronExpression(trimmed);
  } catch {
    return trimmed;
  }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const formatTime = () => {
    if (expr.hour.size === 1 && expr.minute.size === 1) {
      const hour = Array.from(expr.hour)[0] ?? 0;
      const minute = Array.from(expr.minute)[0] ?? 0;
      return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
    }
    return null;
  };
  const time = formatTime();
  // every minute
  if (expr.minute.size > 1 && expr.hour.size === 24) return "Every minute";
  // every hour at minute N
  if (expr.minute.size === 1 && expr.hour.size === 24) {
    const m = Array.from(expr.minute)[0] ?? 0;
    return m === 0 ? "Every hour" : `Every hour at :${m.toString().padStart(2, "0")}`;
  }
  if (time && expr.domWild && expr.dowWild) return `Every day at ${time}`;
  if (time && expr.domWild && !expr.dowWild) {
    const list = Array.from(expr.dow)
      .sort((a, b) => a - b)
      .map((d) => days[d])
      .join(", ");
    return `Every ${list} at ${time}`;
  }
  if (time && !expr.domWild && expr.dowWild) {
    const list = Array.from(expr.dom)
      .sort((a, b) => a - b)
      .join(", ");
    return `On day ${list} of the month at ${time}`;
  }
  return trimmed;
}

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
  getRuntime: (runtimeId: string) => RuntimeConfig | undefined;
  recordActivity?: (event: {
    type: string;
    message: string;
    repoId: string | null;
    workspaceId: string | null;
  }) => void;
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
      workspaceStrategy: input.workspaceStrategy,
      workspaceName: input.workspaceName,
      baseBranch: input.baseBranch ?? null,
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

  delete(id: string): boolean {
    const existing = this.deps.store.findScheduledAgent(id);
    if (!existing) return false;
    this.deps.store.deleteScheduledAgent(id);
    this.deps.recordActivity?.({
      type: "scheduled-agent.deleted",
      message: `Deleted scheduled agent ${existing.name}`,
      repoId: existing.repoId,
      workspaceId: null,
    });
    return true;
  }

  /**
   * Recurring: fire any enabled agent whose cron matches the current minute and
   * whose last run wasn't already in this same minute.
   * One-shot: fire any enabled agent whose runAt has passed and that has never
   * succeeded — then disable it so the tick doesn't keep re-firing.
   */
  async tick(now: Date = new Date()): Promise<string[]> {
    const minuteFloor = floorToMinute(now);
    const fired: string[] = [];
    for (const agent of this.deps.store.listScheduledAgents()) {
      if (!agent.enabled) continue;
      if (agent.scheduleType === "once") {
        if (!agent.runAt) continue;
        const runAt = new Date(agent.runAt).getTime();
        if (Number.isNaN(runAt) || runAt > now.getTime()) continue;
        // Skip anything not "never" — a "running" row means a previous tick is
        // still mid-flight (execute() exceeded the tick interval) and we must
        // not start a second concurrent run. "succeeded"/"failed" are terminal.
        if (agent.lastRunStatus !== "never") continue;
        // Disable BEFORE awaiting runOnce so a slow execute() can't be picked
        // up by the next tick. try/finally guards against runOnce throwing —
        // we must never leave an enabled one-shot whose execute() crashed.
        this.deps.store.updateScheduledAgent(agent.id, { enabled: false });
        try {
          await this.runOnce(agent.id, now);
        } finally {
          fired.push(agent.id);
        }
        continue;
      }
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
      await this.runOnce(agent.id, now);
      fired.push(agent.id);
    }
    return fired;
  }

  /** Triggers a single run regardless of cron schedule (for manual buttons). */
  async runOnce(id: string, now: Date = new Date()): Promise<ScheduledAgentRunResult> {
    const agent = this.deps.store.findScheduledAgent(id);
    if (!agent) throw new Error(`Unknown scheduled agent: ${id}`);
    this.deps.store.recordScheduledAgentRun(id, {
      lastRunAt: now.toISOString(),
      lastRunStatus: "running",
      lastRunMessage: "Run starting",
    });
    const result = await this.execute(agent, now);
    this.deps.store.recordScheduledAgentRun(id, {
      lastRunAt: now.toISOString(),
      lastRunStatus: result.status,
      lastRunMessage: result.message,
      lastWorkspaceId: result.workspaceId,
      lastSessionId: result.sessionId,
    });
    this.deps.recordActivity?.({
      type: `scheduled-agent.${result.status}`,
      message: `${agent.name}: ${result.message}`,
      repoId: agent.repoId,
      workspaceId: result.workspaceId,
    });
    return result;
  }

  private async execute(agent: ScheduledAgent, now: Date): Promise<ScheduledAgentRunResult> {
    const repo = this.deps.store.listRepos().find((candidate) => candidate.id === agent.repoId);
    if (!repo) return failure(agent, "Repository is no longer tracked");
    const runtime = this.deps.getRuntime(agent.runtimeId);
    if (!runtime) return failure(agent, `Runtime ${agent.runtimeId} is not configured`);

    let workspace: Workspace | undefined;
    try {
      workspace = await this.resolveWorkspace(agent, now);
    } catch (error) {
      return failure(agent, error instanceof Error ? error.message : "workspace_resolution_failed");
    }
    if (!workspace) return failure(agent, "Workspace could not be created");
    if (workspace.lifecycle === "failed") return failure(agent, "Workspace creation failed", workspace.id);

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
        },
      );
      return {
        agent,
        status: "succeeded",
        message: `Started ${runtime.displayName} in ${workspace.name}`,
        workspaceId: workspace.id,
        sessionId: session.id,
      };
    } catch (error) {
      return failure(agent, error instanceof Error ? error.message : "session_start_failed", workspace.id);
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

function failure(agent: ScheduledAgent, message: string, workspaceId: string | null = null): ScheduledAgentRunResult {
  return { agent, status: "failed", message, workspaceId, sessionId: null };
}
