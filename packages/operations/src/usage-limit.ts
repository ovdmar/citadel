// Account-wide usage-limit helpers, paired with the claude-code adapter's
// `usage_limited` pane detection.
//
// The adapter writes `pane:usage_limited:reset=<iso>` into AgentSession.
// statusReason when it sees the "You're out of extra usage · resets HH:MM…"
// banner. These helpers parse that encoding back into a wall-clock reset
// moment and derive an account-wide snapshot from the session list.
//
// The auto-resume loop calls `deriveAccountUsageLimit` once per tick (via its
// `isAccountRateLimited` hook) so per-session `rate_limited` retries are
// postponed while the account is capped. The daemon also uses the parsed reset
// to schedule one background resume run at reset+60s.

import type { AgentSession } from "@citadel/contracts";

export interface AccountRateLimitInfo {
  // ISO 8601 wall-clock moment the cap is expected to lift. UTC.
  resetAt: string;
}

// Recognises the `pane:usage_limited:reset=<iso>` (or `=unknown`) format
// the claude-code adapter writes into statusReason. Returns the iso string
// when present and parseable, null otherwise.
export function parseUsageLimitResetFromReason(reason: string | null | undefined): string | null {
  if (typeof reason !== "string") return null;
  const m = /^pane:usage_limited:reset=(.+)$/.exec(reason);
  if (!m) return null;
  const value = m[1] ?? "";
  if (value === "unknown") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

// Walk the session list and return the latest still-future reset time across
// any `usage_limited` session, or null. If multiple sessions report different
// resets, the latest one is the safe choice — once it elapses, the earlier
// ones are also due.
//
// Special cases:
//   - No `usage_limited` session → null
//   - All resets already passed → null (those sessions are due to wake)
//   - At least one `usage_limited` session with unknown reset → 1-min holdover
//     so the auto-resume loop pauses briefly while we wait for the next
//     pane observation to (hopefully) parse a real reset
export function deriveAccountUsageLimit(sessions: AgentSession[], now: Date): AccountRateLimitInfo | null {
  let maxResetMs: number | null = null;
  let anyUnknown = false;
  for (const session of sessions) {
    if (session.status !== "usage_limited") continue;
    const parsed = parseUsageLimitResetFromReason(session.statusReason);
    if (parsed === null) {
      anyUnknown = true;
      continue;
    }
    const ms = Date.parse(parsed);
    if (!Number.isFinite(ms)) continue;
    if (ms <= now.getTime()) continue;
    if (maxResetMs === null || ms > maxResetMs) maxResetMs = ms;
  }
  if (maxResetMs !== null) return { resetAt: new Date(maxResetMs).toISOString() };
  if (anyUnknown) return { resetAt: new Date(now.getTime() + 60_000).toISOString() };
  return null;
}
