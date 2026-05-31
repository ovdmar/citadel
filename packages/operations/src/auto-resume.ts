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
//                            + jitter ∈ [JITTER_MIN_MS, JITTER_MAX_MS)
//
// where N is the attempt-count after incrementing (so the first scheduled
// resume — before any send — uses N=0 → 1min base + jitter 2-15min = 3-16min
// before the first send; after the first send fires, N=1 → 2min base + jitter
// = 4-17min, then 4, 8, 16, 32, 64, 128, 128, 128…). The 128-min base cap is
// preserved (so worst-case per-session retry frequency stays ≤ ~143min) but
// the wide jitter (2-15min) is the load-bearing piece: with many sessions
// hitting the limit at the same time, narrow jitter would let multiple
// sessions land in the same 60s auto-resume tick. Wider jitter spreads them
// across many ticks, so the API sees a smooth trickle of resume nudges
// rather than a stampede.
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
// no DB writes for in-progress rate_limited sessions). Reset-bound
// usage_limited sessions are resumed by the daemon's one-shot background
// scheduled-agent path, not by this per-session backoff loop.

import type { AgentSession } from "@citadel/contracts";
import type { SendMessageResult, SendMessageSource } from "./agent-messages.js";
import { type GuardedIntervalHandle, startGuardedInterval } from "./guarded-interval.js";
import type { AccountRateLimitInfo } from "./usage-limit.js";

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
// Jitter window — added on top of the exponential base wait. Deliberately
// wide (2-15min) so that when many sessions hit the same rate-limit window
// at the same time, their next-resume times spread across ~13min of
// auto-resume ticks (which run at 60s intervals). Without this width, all
// the same-base-attempt sessions would land in the same tick and the API
// would see a burst rather than a trickle.
export const JITTER_MIN_MS = 2 * 60_000;
export const JITTER_MAX_MS = 15 * 60_000;
const JITTER_SPAN_MS = JITTER_MAX_MS - JITTER_MIN_MS;
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
  // Returning a non-null value postpones server-rate-limit auto-resumes while
  // the account-wide usage cap is still active.
  isAccountRateLimited?(): AccountRateLimitInfo | null;
  // Runtime health gate for forced resume nudges. When a runtime is unhealthy
  // (missing command, failed auth/billing probe, etc.), the loop must not send
  // "resume" messages into sessions backed by that runtime.
  isRuntimeHealthy?(runtimeId: string): boolean;
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
// Guarantees: result ∈ [BASE_DELAY_MS + JITTER_MIN_MS, MAX_DELAY_MS + JITTER_MAX_MS).
export function computeNextDelayMs(attempts: number, rng: () => number = Math.random): number {
  const safeAttempts = Math.max(0, Math.floor(attempts));
  const exponent = Math.min(safeAttempts, MAX_EXPONENT);
  const base = Math.min(BASE_DELAY_MS * 2 ** exponent, MAX_DELAY_MS);
  const rawJitter = rng();
  const jitter = JITTER_MIN_MS + (Number.isFinite(rawJitter) ? rawJitter : 0) * JITTER_SPAN_MS;
  return Math.round(base + jitter);
}

export async function runAutoResumeTick(deps: AutoResumeDeps): Promise<AutoResumeTickResult> {
  const rng = deps.rng ?? Math.random;
  const accountLimit = deps.isAccountRateLimited?.() ?? null;
  const nowDate = deps.now();
  const nowMs = nowDate.getTime();
  const sessions = deps.listSessions();
  const runtimeHealthCache = new Map<string, boolean>();
  const runtimeCanResume = (runtimeId: string): boolean => {
    if (!deps.isRuntimeHealthy) return true;
    const cached = runtimeHealthCache.get(runtimeId);
    if (cached !== undefined) return cached;
    let healthy = false;
    try {
      healthy = deps.isRuntimeHealthy(runtimeId);
    } catch (err) {
      deps.logger?.warn?.(`[auto-resume] runtime health check threw for ${runtimeId}: ${String(err)}`);
    }
    runtimeHealthCache.set(runtimeId, healthy);
    return healthy;
  };
  const result: AutoResumeTickResult = {
    resumed: 0,
    scheduled: 0,
    cleared: 0,
    healed: 0,
    postponed: accountLimit !== null,
  };

  for (const session of sessions) {
    if (session.status === "usage_limited") {
      // Reset-bound usage limits are account-wide. The daemon schedules a
      // single one-shot background agent for reset+60s that resumes every
      // still-limited session together. Keep this loop out of that path so it
      // does not race the scheduled background run with direct per-session
      // sends.
      continue;
    }

    if (session.status === "rate_limited") {
      if (!runtimeCanResume(session.runtimeId)) continue;
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
      // Session is no longer in *any* limited state; clear stale resume
      // bookkeeping so a future rate-limit episode starts a fresh backoff
      // curve. We deliberately keep `lastResumeFromRateLimitAt` as a
      // historical breadcrumb.
      //
      // Important: usage_limited never reaches this branch because the
      // usage_limited block at the top of the loop `continue`s out. That
      // protects rate_limited backoff across rate_limited ↔ usage_limited
      // oscillation — without that early-continue, each flip to
      // usage_limited would wipe attempts and the next rate_limited
      // episode would restart at the 1-min initial backoff, sending ~one
      // nudge per minute against a sustained limit.
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
