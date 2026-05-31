import type http from "node:http";
import type { CitadelConfig } from "@citadel/config";
import type { AgentSession, ScheduledAgent } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { deriveAccountUsageLimit, parseUsageLimitResetFromReason } from "@citadel/operations";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { ScheduledAgentService } from "./scheduled-agent-service.js";

export const RATE_LIMIT_BACKGROUND_RESUME_MARKER = "citadel-internal:rate-limit-background-resume";
export const RATE_LIMIT_BACKGROUND_RESUME_NAME = "Rate-limit auto-resume";
export const RATE_LIMIT_BACKGROUND_RESUME_DELAY_MS = 60_000;
export const DEFAULT_RATE_LIMIT_BACKGROUND_RESUME_INTERVAL_MS = 60_000;

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => express.RequestHandler;

export type RateLimitBackgroundScheduleResult =
  | { kind: "no_reset" }
  | { kind: "missing_repo_or_runtime" }
  | { kind: "already_scheduled"; scheduledAgentId: string; runAt: string }
  | { kind: "updated"; scheduledAgentId: string; runAt: string }
  | { kind: "created"; scheduledAgentId: string; runAt: string }
  | { kind: "failed"; error: string };

export type RateLimitResumeResult = {
  resumed: string[];
  skipped: Array<{ sessionId: string; reason: string }>;
  postponedUntil: string | null;
};

export function startRateLimitBackgroundResumeScheduler(deps: {
  store: SqliteStore;
  scheduledAgentService: ScheduledAgentService;
  config: CitadelConfig;
  emit?: (type: string, payload: unknown) => void;
}): { stop(): void } | null {
  if (process.env.CITADEL_DISABLE_RATE_LIMIT_BACKGROUND_RESUME === "1") return null;
  const intervalEnv = Number(process.env.CITADEL_RATE_LIMIT_BACKGROUND_RESUME_INTERVAL_MS);
  const intervalMs =
    Number.isFinite(intervalEnv) && intervalEnv > 0 ? intervalEnv : DEFAULT_RATE_LIMIT_BACKGROUND_RESUME_INTERVAL_MS;

  const tick = () => {
    const result = scheduleRateLimitBackgroundResume(deps);
    if (result.kind === "created" || result.kind === "updated") {
      deps.emit?.("rate-limit.background-resume.scheduled", result);
    }
  };

  const interval = setInterval(tick, intervalMs);
  interval.unref();
  tick();
  return { stop: () => clearInterval(interval) };
}

export function wireRateLimitBackgroundResume(
  app: express.Express,
  server: http.Server,
  deps: {
    store: SqliteStore;
    operations: OperationService;
    config: CitadelConfig;
    asyncRoute: AsyncRoute;
    emit: (type: string, payload: unknown) => void;
    scheduledAgentService: ScheduledAgentService;
  },
) {
  registerRateLimitBackgroundResumeRoute(app, deps);
  const scheduler = startRateLimitBackgroundResumeScheduler(deps);
  if (scheduler) server.on("close", () => scheduler.stop());
}

export function registerRateLimitBackgroundResumeRoute(
  app: express.Express,
  deps: {
    store: SqliteStore;
    operations: OperationService;
    config: CitadelConfig;
    asyncRoute: AsyncRoute;
    emit: (type: string, payload: unknown) => void;
  },
) {
  app.post(
    "/api/internal/rate-limit-auto-resume",
    deps.asyncRoute(async (_req, res) => {
      const result = await resumeRateLimitedSessions({
        store: deps.store,
        operations: deps.operations,
        config: deps.config,
      });
      deps.emit("rate-limit.background-resume.executed", result);
      res.status(result.postponedUntil ? 202 : 200).json(result);
    }),
  );
}

export function scheduleRateLimitBackgroundResume(deps: {
  store: SqliteStore;
  scheduledAgentService: ScheduledAgentService;
  config: CitadelConfig;
  now?: Date;
}): RateLimitBackgroundScheduleResult {
  const now = deps.now ?? new Date();
  const resetAt = latestUsageLimitReset(deps.store.listSessions());
  if (!resetAt) return { kind: "no_reset" };

  const runAt = computeBackgroundResumeRunAt(resetAt, now);
  const pending = findPendingRateLimitBackgroundResume(deps.store);
  if (pending?.runAt) {
    if (Date.parse(pending.runAt) >= Date.parse(runAt)) {
      return { kind: "already_scheduled", scheduledAgentId: pending.id, runAt: pending.runAt };
    }
    const updated = deps.scheduledAgentService.update(pending.id, {
      scheduleType: "once",
      runAt,
      prompt: buildRateLimitBackgroundResumePrompt(localDaemonBaseUrl(deps.config)),
      enabled: true,
    });
    if (!updated.ok || !updated.value)
      return { kind: "failed", error: updated.ok ? "scheduled_agent_missing" : updated.error };
    return { kind: "updated", scheduledAgentId: updated.value.id, runAt: updated.value.runAt ?? runAt };
  }

  const target = chooseSchedulingTarget(deps.store, deps.config);
  if (!target) return { kind: "missing_repo_or_runtime" };
  const created = deps.scheduledAgentService.create({
    name: RATE_LIMIT_BACKGROUND_RESUME_NAME,
    description: RATE_LIMIT_BACKGROUND_RESUME_MARKER,
    scheduleType: "once",
    runAt,
    repoId: target.repoId,
    runtimeId: target.runtimeId,
    prompt: buildRateLimitBackgroundResumePrompt(localDaemonBaseUrl(deps.config)),
    runMode: "background",
    backgroundCwd: target.cwd,
    overlapPolicy: "skip",
    enabled: true,
  });
  if (!created.ok) return { kind: "failed", error: created.error };
  return { kind: "created", scheduledAgentId: created.value.id, runAt: created.value.runAt ?? runAt };
}

export async function resumeRateLimitedSessions(deps: {
  store: SqliteStore;
  operations: OperationService;
  config: CitadelConfig;
  now?: Date;
}): Promise<RateLimitResumeResult> {
  const now = deps.now ?? new Date();
  const sessions = deps.store.listSessions();
  const accountLimit = deriveAccountUsageLimit(healthySessions(sessions, deps.config), now);
  if (accountLimit) {
    return { resumed: [], skipped: [], postponedUntil: accountLimit.resetAt };
  }

  const resumed: string[] = [];
  const skipped: Array<{ sessionId: string; reason: string }> = [];
  const healthyRuntimeIds = new Set(
    listRuntimeHealth(deps.config.runtimes)
      .filter((runtime) => runtime.health === "healthy")
      .map((runtime) => runtime.id),
  );

  for (const session of sessions) {
    if (session.status !== "rate_limited" && session.status !== "usage_limited") continue;
    if (!healthyRuntimeIds.has(session.runtimeId)) {
      skipped.push({ sessionId: session.id, reason: "runtime_unhealthy" });
      continue;
    }
    if (!usageLimitReady(session, now)) {
      skipped.push({ sessionId: session.id, reason: "reset_not_due" });
      continue;
    }

    const result = await deps.operations.sendAgentMessage({
      sessionId: session.id,
      message: "resume",
      source: "system",
      optimistic: false,
    });
    if (!result.ok) {
      skipped.push({ sessionId: session.id, reason: result.error ?? "send_failed" });
      continue;
    }
    deps.store.updateSessionRateLimitResume(session.id, {
      rateLimitResumeAttempts: 0,
      nextResumeAt: null,
      lastResumeFromRateLimitAt: now.toISOString(),
    });
    resumed.push(session.id);
  }

  return { resumed, skipped, postponedUntil: null };
}

export function buildRateLimitBackgroundResumePrompt(baseUrl: string): string {
  const endpoint = `${baseUrl}/api/internal/rate-limit-auto-resume`;
  const script = [
    `const res=await fetch(${JSON.stringify(endpoint)},{method:"POST"});`,
    "const text=await res.text();",
    "console.log(text);",
    "process.exit(res.ok?0:1);",
  ].join("");
  return `node --input-type=module -e ${shellSingleQuote(script)}; exit`;
}

export function computeBackgroundResumeRunAt(resetAt: string, now: Date): string {
  const resetMs = Date.parse(resetAt);
  const dueMs = Number.isFinite(resetMs) ? resetMs + RATE_LIMIT_BACKGROUND_RESUME_DELAY_MS : now.getTime();
  return new Date(Math.max(now.getTime(), dueMs)).toISOString();
}

export function findPendingRateLimitBackgroundResume(
  store: Pick<SqliteStore, "listScheduledAgents">,
): ScheduledAgent | null {
  return (
    store
      .listScheduledAgents()
      .find(
        (agent) =>
          agent.description === RATE_LIMIT_BACKGROUND_RESUME_MARKER &&
          agent.scheduleType === "once" &&
          agent.enabled &&
          agent.lastRunStatus === "never" &&
          agent.runAt !== null,
      ) ?? null
  );
}

function latestUsageLimitReset(sessions: AgentSession[]): string | null {
  let latestMs: number | null = null;
  for (const session of sessions) {
    if (session.status !== "usage_limited") continue;
    const resetAt = parseUsageLimitResetFromReason(session.statusReason);
    if (!resetAt) continue;
    const resetMs = Date.parse(resetAt);
    if (!Number.isFinite(resetMs)) continue;
    const lastResumeMs = Date.parse(session.lastResumeFromRateLimitAt ?? "");
    if (Number.isFinite(lastResumeMs) && lastResumeMs >= resetMs) continue;
    if (latestMs === null || resetMs > latestMs) latestMs = resetMs;
  }
  return latestMs === null ? null : new Date(latestMs).toISOString();
}

function usageLimitReady(session: AgentSession, now: Date): boolean {
  if (session.status !== "usage_limited") return true;
  const resetAt = parseUsageLimitResetFromReason(session.statusReason);
  if (!resetAt) return false;
  const resetMs = Date.parse(resetAt);
  if (!Number.isFinite(resetMs)) return false;
  if (resetMs + RATE_LIMIT_BACKGROUND_RESUME_DELAY_MS > now.getTime()) return false;
  const last = session.lastResumeFromRateLimitAt;
  if (!last) return true;
  const lastMs = Date.parse(last);
  return !Number.isFinite(lastMs) || lastMs < resetMs;
}

function healthySessions(sessions: AgentSession[], config: CitadelConfig): AgentSession[] {
  const healthyRuntimeIds = new Set(
    listRuntimeHealth(config.runtimes)
      .filter((runtime) => runtime.health === "healthy")
      .map((runtime) => runtime.id),
  );
  return sessions.filter((session) => healthyRuntimeIds.has(session.runtimeId));
}

function chooseSchedulingTarget(
  store: Pick<SqliteStore, "listRepos" | "listSessions" | "listWorkspaces">,
  config: CitadelConfig,
): { repoId: string; runtimeId: string; cwd: string } | null {
  const repos = store.listRepos();
  const workspaces = store.listWorkspaces();
  const limitedWorkspaceId = store
    .listSessions()
    .find((session) => session.status === "usage_limited" || session.status === "rate_limited")?.workspaceId;
  const workspace = limitedWorkspaceId
    ? workspaces.find((candidate) => candidate.id === limitedWorkspaceId)
    : undefined;
  const repo = (workspace ? repos.find((candidate) => candidate.id === workspace.repoId) : undefined) ?? repos[0];
  const runtime = config.runtimes.find((candidate) => candidate.id === "shell") ?? config.runtimes[0];
  if (!repo || !runtime) return null;
  return { repoId: repo.id, runtimeId: runtime.id, cwd: repo.rootPath };
}

function localDaemonBaseUrl(config: CitadelConfig): string {
  const host = config.bindHost === "0.0.0.0" || config.bindHost === "::" ? "127.0.0.1" : config.bindHost;
  const printableHost = host.includes(":") ? `[${host}]` : host;
  return `http://${printableHost}:${config.port}`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
