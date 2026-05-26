// Auto-resume loop for sessions that hit the global API rate limit.
//
// When an agent's pane shows the "Server is temporarily limiting requests"
// banner, the runtime status adapter flips the session to `rate_limited`.
// That used to be a dead end — the agent would sit idle until the user
// nudged it. This loop fixes that: it periodically scans rate-limited
// sessions, waits per-session exponential-backoff windows, and submits a
// generic resume nudge (one of RESUME_PROMPTS picked at random) to wake the
// agent back up.
//
// Backoff curve (per-session, current rate-limit episode):
//
//   schedule attempt #N  →  base_delay = min(BASE_DELAY_MS × 2^N, MAX_DELAY_MS)
//                            + jitter ∈ [0, JITTER_MS)
//
// where N is the attempt-count after incrementing (so the first scheduled
// resume — before any send — uses N=0 → 1min + jitter; after the first send
// fires, N=1 → 2min, then 4, 8, 16, 32, 64, 128, 128, 128…). The cap is
// 128min so a session that never recovers is retried at most ~11 times per
// day — bounded token cost, no infinite hot loop.
//
// Per-session backoff state is persisted on the session row so it survives
// daemon restarts. The fields touched here are:
//   - rateLimitResumeAttempts: consecutive auto-resume sends, for backoff
//   - nextResumeAt: when the loop is allowed to attempt the next resume
//   - lastResumeFromRateLimitAt: wall clock of the most recent send
//
// Account-wide rate-limit detection: the `isAccountRateLimited` dep returns
// a non-null value when the operator is in a "you're out of credits until
// HH:MM" window. When set, every per-session resume is postponed (no sends,
// no DB writes for in-progress rate_limited sessions).

import type { AgentSession } from "@citadel/contracts";
import type { SendMessageResult, SendMessageSource } from "./agent-messages.js";
import { type GuardedIntervalHandle, startGuardedInterval } from "./guarded-interval.js";
import { type AccountRateLimitInfo, parseUsageLimitResetFromReason } from "./usage-limit.js";

// Ten generic resume nudges. We never reuse the agent's original prompt
// because the runtime already has the conversation history; a short
// "continue" cue is enough and keeps the user-visible transcript sane.
export const RESUME_PROMPTS: readonly string[] = Object.freeze([
  "resume",
  "let's resume",
  "we're ready to resume",
  "we can resume now",
  "let's continue",
  "ready to continue",
  "please continue",
  "continue, please",
  "go ahead, continue",
  "you can continue now",
]);

// One minute base. Each consecutive resume doubles up to a 128-minute cap.
export const BASE_DELAY_MS = 60_000;
export const MAX_DELAY_MS = 128 * 60_000;
export const JITTER_MS = 60_000;
// Cap the doubling exponent so 2^N can't overflow for pathological attempt
// counts. We hit MAX_DELAY_MS at N=7 (2^7 = 128), so anything beyond is the
// same answer either way; this is purely defense in depth.
const MAX_EXPONENT = 12;
export const DEFAULT_AUTO_RESUME_INTERVAL_MS = 60_000;

export interface AutoResumeDeps {
  now(): Date;
  listSessions(): AgentSession[];
  sendAgentMessage(input: {
    sessionId: string;
    message: string;
    source?: SendMessageSource;
    optimistic?: boolean;
  }): Promise<SendMessageResult>;
  updateRateLimitResume(
    sessionId: string,
    update: {
      rateLimitResumeAttempts?: number;
      nextResumeAt?: string | null;
      lastResumeFromRateLimitAt?: string | null;
    },
  ): void;
  // Future hook: when account-wide rate-limit detection lands, returning a
  // non-null value postpones every auto-resume until reset.
  isAccountRateLimited?(): AccountRateLimitInfo | null;
  rng?(): number;
  logger?: { warn(msg: string, meta?: unknown): void };
}

export interface AutoResumeTickResult {
  // Number of sessions where we submitted a resume prompt this tick.
  resumed: number;
  // Number of sessions that newly entered the queue (nextResumeAt was null
  // and we scheduled the first attempt).
  scheduled: number;
  // Number of non-rate-limited sessions whose stale resume state we cleared.
  cleared: number;
  // Number of sessions whose corrupted nextResumeAt was nulled out as part
  // of the self-heal path (B1).
  healed: number;
  // True when the tick short-circuited because account-wide rate limit is
  // active.
  postponed: boolean;
}

export type AutoResumeLoopHandle = GuardedIntervalHandle;

export function pickResumePrompt(rng: () => number = Math.random): string {
  const raw = rng();
  const normalized = Number.isFinite(raw) ? raw : 0;
  const idx = Math.min(RESUME_PROMPTS.length - 1, Math.max(0, Math.floor(normalized * RESUME_PROMPTS.length)));
  return RESUME_PROMPTS[idx] as string;
}

// `attempts` here is the count *after* incrementing for the resume that
// just fired (or 0 for the very first scheduled resume on a fresh
// rate_limited session). Returns the wait-in-ms before the next resume.
// Guarantees: result ∈ [BASE_DELAY_MS, MAX_DELAY_MS + JITTER_MS).
export function computeNextDelayMs(attempts: number, rng: () => number = Math.random): number {
  const safeAttempts = Math.max(0, Math.floor(attempts));
  const exponent = Math.min(safeAttempts, MAX_EXPONENT);
  const base = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  const rawJitter = rng();
  const jitter = (Number.isFinite(rawJitter) ? rawJitter : 0) * JITTER_MS;
  return Math.round(base + jitter);
}

export async function runAutoResumeTick(deps: AutoResumeDeps): Promise<AutoResumeTickResult> {
  const rng = deps.rng ?? Math.random;
  const accountLimit = deps.isAccountRateLimited?.() ?? null;
  const nowDate = deps.now();
  const nowMs = nowDate.getTime();
  const sessions = deps.listSessions();
  const result: AutoResumeTickResult = {
    resumed: 0,
    scheduled: 0,
    cleared: 0,
    healed: 0,
    postponed: accountLimit !== null,
  };

  for (const session of sessions) {
    if (session.status === "usage_limited") {
      // Account-wide cap: wait until the reset wall-clock passes, then send
      // a single nudge to wake the agent. No backoff escalation — the reset
      // moment is deterministic, and if the agent is still capped after the
      // nudge the next pane observation re-stamps usage_limited with the
      // next reset and we re-enter this branch.
      const resetAt = parseUsageLimitResetFromReason(session.statusReason);
      if (resetAt === null) continue; // Unknown reset — let the wall clock catch up.
      if (Date.parse(resetAt) > nowMs) continue;
      const prompt = pickResumePrompt(rng);
      try {
        const sendResult = await deps.sendAgentMessage({
          sessionId: session.id,
          message: prompt,
          source: "system",
          optimistic: false,
        });
        if (sendResult.ok) {
          result.resumed += 1;
        } else {
          deps.logger?.warn?.(`[auto-resume] usage-limit nudge failed for ${session.id}: ${sendResult.error ?? "?"}`);
        }
      } catch (err) {
        deps.logger?.warn?.(`[auto-resume] usage-limit nudge threw for ${session.id}: ${String(err)}`);
      }
      continue;
    }

    if (session.status === "rate_limited") {
      if (accountLimit) continue; // Account-wide rate limit — defer everything.
      const nextResumeAt = session.nextResumeAt ?? null;
      if (nextResumeAt === null) {
        // First-time scheduling: attempt-0 base (1 min) + jitter.
        const scheduled = new Date(nowMs + computeNextDelayMs(0, rng)).toISOString();
        deps.updateRateLimitResume(session.id, { nextResumeAt: scheduled });
        result.scheduled += 1;
        continue;
      }
      const scheduledMs = Date.parse(nextResumeAt);
      if (Number.isNaN(scheduledMs)) {
        // B1 self-heal: corrupted timestamp would otherwise strand the
        // session forever (never due, never reset). Null it out so next
        // tick reschedules via the first-time branch.
        deps.logger?.warn?.(
          `[auto-resume] session ${session.id} has unparseable nextResumeAt=${JSON.stringify(nextResumeAt)}; clearing`,
        );
        deps.updateRateLimitResume(session.id, { nextResumeAt: null });
        result.healed += 1;
        continue;
      }
      if (scheduledMs > nowMs) continue; // Not due yet.

      const prompt = pickResumePrompt(rng);
      let sendOk = false;
      try {
        const sendResult = await deps.sendAgentMessage({
          sessionId: session.id,
          message: prompt,
          source: "system",
          // B3 fix: do not optimistically flip rate_limited → running on
          // auto-resume sends. We want the next status-monitor tick to
          // confirm via real pane observation whether the banner cleared,
          // so the clear-branch below doesn't reset backoff prematurely.
          optimistic: false,
        });
        sendOk = Boolean(sendResult.ok);
        if (!sendOk) {
          deps.logger?.warn?.(`[auto-resume] send failed for session ${session.id}: ${sendResult.error ?? "unknown"}`);
        }
      } catch (err) {
        deps.logger?.warn?.(`[auto-resume] send threw for session ${session.id}: ${String(err)}`);
      }

      // Bump attempts and schedule the next attempt regardless of send
      // outcome. If the send failed (e.g. tmux gone), we'll keep backing
      // off; the 128-minute cap means even a permanently-broken session
      // is hit at most ~11 times per day.
      const nextAttempts = (session.rateLimitResumeAttempts ?? 0) + 1;
      const delayMs = computeNextDelayMs(nextAttempts, rng);
      const nowIso = nowDate.toISOString();
      const scheduledNext = new Date(nowMs + delayMs).toISOString();
      const update: {
        rateLimitResumeAttempts: number;
        nextResumeAt: string;
        lastResumeFromRateLimitAt?: string;
      } = {
        rateLimitResumeAttempts: nextAttempts,
        nextResumeAt: scheduledNext,
      };
      if (sendOk) update.lastResumeFromRateLimitAt = nowIso;
      deps.updateRateLimitResume(session.id, update);
      if (sendOk) result.resumed += 1;
    } else {
      // Session is no longer rate-limited; clear stale resume bookkeeping
      // so a future rate-limit episode starts a fresh backoff curve. We
      // deliberately keep `lastResumeFromRateLimitAt` as a historical
      // breadcrumb.
      const hasAttempts = (session.rateLimitResumeAttempts ?? 0) > 0;
      const hasNext = session.nextResumeAt != null;
      if (hasAttempts || hasNext) {
        const update: { rateLimitResumeAttempts?: number; nextResumeAt?: string | null } = {};
        if (hasAttempts) update.rateLimitResumeAttempts = 0;
        if (hasNext) update.nextResumeAt = null;
        deps.updateRateLimitResume(session.id, update);
        result.cleared += 1;
      }
    }
  }

  return result;
}

export function startAutoResumeLoop(
  deps: AutoResumeDeps,
  intervalMs: number = DEFAULT_AUTO_RESUME_INTERVAL_MS,
): AutoResumeLoopHandle {
  return startGuardedInterval(() => runAutoResumeTick(deps), intervalMs, {
    error: (_msg, err) => deps.logger?.warn?.(`[auto-resume] tick failed: ${String(err)}`),
  });
}
