import type { AgentSession, RateLimitResumption } from "@citadel/contracts";
import { createId, nowIso, parseRateLimitReason } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { ResumeOutcome } from "./rate-limit-resumer.js";
import type { MonitorSessionState } from "./status-monitor.js";

// One-minute delay added on top of the earliest reset time. Operators can
// override at the resumer level (e.g. a longer floor when the runtime is
// known to be flaky). 60s is a deliberate choice — we want the runtime's
// internal clock to clearly cross the boundary before we send Enter.
const RESUME_DELAY_MS = 60_000;

export type SchedulerDeps = {
  store: SqliteStore;
  now: () => string;
  monitorStates: Map<string, MonitorSessionState>;
  resumeSession: (sessionId: string) => Promise<ResumeOutcome>;
  emit: (event: string, payload: unknown) => void;
};

export type SchedulerTickResult = {
  scheduled: boolean;
  executed: number;
  skipped: number;
};

// Identify the subset of rate-limited sessions that are eligible candidates
// for the schedule/execute phases. A candidate must:
//   - have status === "rate_limited"
//   - carry a parseable, NON-NULL resetAt in its statusReason (unknown_reset
//     sessions cannot be scheduled — we don't know when the reset is)
//   - have a backing tmux session
//   - have completed at least one full post-boot monitor tick (the
//     hasCompletedFirstTick gate). This prevents the very first post-boot
//     tick from acting on stale rate_limited rows whose runtime may already
//     have recovered during downtime.
function eligibleCandidates(
  sessions: AgentSession[],
  monitorStates: Map<string, MonitorSessionState>,
): Array<{ session: AgentSession; resetAt: string }> {
  const out: Array<{ session: AgentSession; resetAt: string }> = [];
  for (const session of sessions) {
    if (session.status !== "rate_limited") continue;
    if (!session.tmuxSessionName) continue;
    if (!session.statusReason) continue;
    const parsed = parseRateLimitReason(session.statusReason);
    if (!parsed || parsed.resetAt === null) continue;
    const monitorState = monitorStates.get(session.id);
    if (!monitorState?.hasCompletedFirstTick) continue;
    out.push({ session, resetAt: parsed.resetAt });
  }
  return out;
}

// Background scheduled-agent sessions: identify by tmux_session_name being
// present in the background_sessions table. Their lifecycle is controlled by
// the scheduled-agent runner; do NOT interfere with Enter.
function isBackgroundSession(store: SqliteStore, tmuxSessionName: string | null): boolean {
  if (!tmuxSessionName) return false;
  // background_sessions is small and this runs at most once per due row.
  // Linear scan is fine.
  return store.listRunningBackgroundSessions().some((bg) => bg.tmuxSessionName === tmuxSessionName);
}

// One tick of the rate-limit scheduler. Invoked at the END of
// runStatusMonitorTick (after observations have persisted) and BEFORE the
// hasCompletedFirstTick flip. The two-phase shape mirrors the monitor:
//   1. SCHEDULE — if any rate-limited candidate is observable and no pending
//      row exists, insert one at max(now+60s, min(resetAt)+60s).
//   2. EXECUTE — pop every due row; for each, fan out resumeSession across
//      the currently-rate-limited candidates whose resetAt has actually
//      passed (skip ones whose reset is still in the future), then mark
//      executed.
export async function runRateLimitSchedulerTick(deps: SchedulerDeps): Promise<SchedulerTickResult> {
  const now = deps.now();
  const nowMs = Date.parse(now);
  const sessions = deps.store.listSessions();
  const candidates = eligibleCandidates(sessions, deps.monitorStates);

  let scheduled = false;
  let executed = 0;
  let skipped = 0;

  // ---- SCHEDULE phase ----
  if (candidates.length > 0 && deps.store.findPendingRateLimitResumption() === null) {
    let earliestMs = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const ms = Date.parse(candidate.resetAt);
      if (Number.isFinite(ms) && ms < earliestMs) earliestMs = ms;
    }
    if (Number.isFinite(earliestMs)) {
      const scheduledAt = new Date(Math.max(nowMs + RESUME_DELAY_MS, earliestMs + RESUME_DELAY_MS)).toISOString();
      const row: RateLimitResumption = {
        id: createId("rlr"),
        scheduledAt,
        status: "pending",
        createdAt: now,
        executedAt: null,
      };
      deps.store.insertRateLimitResumption(row);
      scheduled = true;
    }
  }

  // ---- EXECUTE phase ----
  const due = deps.store.listDueRateLimitResumptions(now);
  for (const row of due) {
    const resumed: string[] = [];
    const skippedIds: string[] = [];
    // Re-evaluate candidates fresh inside the loop — the world may have
    // changed since the schedule phase (sessions stopped, new ones appeared).
    const dueCandidates = eligibleCandidates(deps.store.listSessions(), deps.monitorStates);
    for (const { session, resetAt } of dueCandidates) {
      // Per-session reset-due gate: only resume if reset has actually passed.
      if (Date.parse(resetAt) > nowMs) {
        skippedIds.push(session.id);
        continue;
      }
      // Background scheduled-agent sessions are excluded.
      if (isBackgroundSession(deps.store, session.tmuxSessionName)) {
        skippedIds.push(session.id);
        continue;
      }
      const outcome = await deps.resumeSession(session.id);
      if (outcome.resumed) {
        resumed.push(session.id);
      } else {
        skippedIds.push(session.id);
      }
    }
    deps.store.markRateLimitResumptionExecuted(row.id, now);
    deps.emit("rate-limit.resumed", { resumptionId: row.id, resumed, skipped: skippedIds });
    executed += resumed.length;
    skipped += skippedIds.length;
  }

  return { scheduled, executed, skipped };
}
