import { ApiError } from "../api.js";

// MIN_SPIN_MS: minimum visible-spinner duration when the redeploy succeeds or
// goes into watchdog mode. Honest 4xx/5xx errors clear inFlight immediately
// (no MIN_SPIN_MS masking) so the operator sees the error toast right away.
// TODO(B.7-SSE): revisit when operations gain progress streaming so we don't
// rely on a hardcoded floor.
export const MIN_SPIN_MS = 4_000;
export const WATCHDOG_MAX_MS = 30_000;
export const WATCHDOG_INTERVAL_MS = 1_000;
// AbortSignal.timeout cap for the pre-redeploy /api/state fetch — keeps the
// click-to-spinner latency bounded even when the daemon is mid-restart.
export const PREFETCH_TIMEOUT_MS = 1_500;

export type RedeployErrorKind = "network" | "other";

// Network errors look like a Promise rejection from fetch with no Response
// attached: AbortError, TypeError("Failed to fetch"), DNS failures, etc.
// `ApiError` has an HTTP status set when the daemon returned a body — those
// are honest 4xx/5xx and must NOT take the watchdog path.
export function classifyRedeployError(error: unknown): RedeployErrorKind {
  if (error instanceof ApiError && typeof error.status === "number") return "other";
  if (error instanceof Error) {
    if (error.name === "AbortError") return "network";
    if (error.name === "TypeError") return "network";
    const message = error.message || "";
    if (/network|failed to fetch|fetch failed/i.test(message)) return "network";
  }
  return "other";
}

// Watchdog decides whether to clear the spinner based on the daemon-start
// token. A fresh fetch of /api/state returns the *new* daemon's
// daemonStartedAt; only a strictly newer ISO string (lexicographically larger
// since ISO sorts as text) means the daemon has restarted.
export function watchdogShouldClear(preToken: string | null, currentToken: string | null | undefined): boolean {
  if (!currentToken) return false;
  if (preToken === null) return true; // pre-fetch failed → clear on any successful poll
  return currentToken > preToken;
}
