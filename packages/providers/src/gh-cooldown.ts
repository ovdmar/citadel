// Global gh rate-limit circuit breaker. When gh reports
// "API rate limit ... exceeded", we stop spawning gh subprocesses entirely
// until the cooldown clears. Every gh-touching code path in providers/index.ts
// goes through gh(), so a single gate here covers PR view, commit checks, run
// list, auth status, merge, etc. without each call site needing its own retry
// logic.
//
// Why a flat 15-minute default: gh CLI errors do not consistently expose the
// X-RateLimit-Reset header, and the user's primary rate budget is GraphQL
// (REST + GraphQL share quota but reset on different windows). 15 minutes is
// long enough to avoid hammering during the cooldown and short enough that a
// stale cooldown self-heals if we mis-classify.

export const DEFAULT_GH_COOLDOWN_MS = 15 * 60 * 1000;

let ghCooldownUntil = 0;
let ghCooldownReason: string | null = null;

export class GhRateLimitedError extends Error {
  readonly until: number;
  constructor(until: number, reason: string) {
    super(`gh rate-limited; cooling until ${new Date(until).toISOString()}: ${reason}`);
    this.name = "GhRateLimitedError";
    this.until = until;
  }
}

export function getGhCooldown(): { until: number; reason: string } | null {
  if (ghCooldownUntil <= Date.now()) return null;
  return { until: ghCooldownUntil, reason: ghCooldownReason ?? "rate limit" };
}

// Exposed so tests / explicit user actions ("retry now" button) can clear
// the cooldown without restarting the daemon.
export function clearGhCooldown(): void {
  ghCooldownUntil = 0;
  ghCooldownReason = null;
}

// Internal — set by gh() when it catches a rate-limit error. Not part of the
// public API; callers go through gh().
export function setGhCooldown(reason: string, durationMs: number = DEFAULT_GH_COOLDOWN_MS): number {
  ghCooldownUntil = Date.now() + durationMs;
  ghCooldownReason = reason;
  return ghCooldownUntil;
}

export function getGhCooldownUntil(): number {
  return ghCooldownUntil;
}

export function getGhCooldownReason(): string | null {
  return ghCooldownReason;
}

export function isRateLimitError(error: unknown): false | string {
  const candidates: string[] = [];
  if (typeof error === "string") candidates.push(error);
  else if (error && typeof error === "object") {
    const obj = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
    if (typeof obj.message === "string") candidates.push(obj.message);
    if (typeof obj.stderr === "string") candidates.push(obj.stderr);
    if (typeof obj.stdout === "string") candidates.push(obj.stdout);
  }
  for (const text of candidates) {
    // gh prints variants like:
    //   "API rate limit exceeded for user ID 12345"
    //   "GraphQL: API rate limit already exceeded for user ID ..."
    //   "You have exceeded a secondary rate limit"
    if (/rate[- ]limit (already )?exceeded|secondary rate[- ]limit|abuse[- ]rate[- ]limit/i.test(text)) {
      return text.trim().slice(0, 240);
    }
  }
  return false;
}
