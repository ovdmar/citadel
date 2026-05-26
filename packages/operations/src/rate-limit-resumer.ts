import type { ActivityEvent, AgentSession } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { RuntimeStatusAdapter } from "@citadel/runtimes";

// Outcome of a single resumption attempt. `resumed: true` means an Enter
// keystroke was actually sent; `false` means we suppressed it (with reason).
export type ResumeOutcome = {
  resumed: boolean;
  reason: string;
};

export type RateLimitResumerDeps = {
  store: SqliteStore;
  paneCapture: (tmuxSessionName: string) => string;
  pressEnter: (tmuxSessionName: string) => { ok: boolean; error?: string };
  getAdapter: (runtimeId: string) => RuntimeStatusAdapter;
  now?: () => string;
};

// Match a user-input prompt line: a runtime input prefix character followed by
// at least one non-whitespace character. Suppress Enter when this matches —
// the operator has typed something into the input area and Enter would
// submit that text.
//
// Currently scoped to the unicode angle prompts (❯, ›) both Claude Code and
// Codex render in their input row. Calibrate per-runtime as fixtures land.
const USER_INPUT_BOTTOM_LINE_REGEX = /^[❯›]\s+\S/;

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line !== undefined && line.trim().length > 0) return line.trim();
  }
  return "";
}

// Try to resume a single rate-limited session. Returns the outcome so the
// scheduler can record per-session results.
//
// Safety guards (in order):
//   1. Session still exists, status is rate_limited, tmuxSessionName present.
//   2. Pane re-capture confirms the rate-limit banner is still visible
//      (delegates to the runtime adapter's stateless detectRateLimit).
//   3. Bottom-line shape check: the input row is NOT in an active operator-
//      input state (no `❯ <text>` pattern). This is a second guard against
//      the narrow TOCTOU window between capture and Enter.
//
// Only after all three pass do we send Enter and record the activity event.
export async function resumeRateLimitedSession(
  deps: RateLimitResumerDeps,
  input: { sessionId: string },
): Promise<ResumeOutcome> {
  const now = deps.now ?? nowIso;
  const session = deps.store
    .listSessions()
    .find((candidate: AgentSession) => candidate.id === input.sessionId);
  if (!session) return { resumed: false, reason: "session_not_found" };
  if (session.status !== "rate_limited") return { resumed: false, reason: "session_not_rate_limited" };
  if (!session.tmuxSessionName) return { resumed: false, reason: "session_has_no_terminal" };

  const pane = deps.paneCapture(session.tmuxSessionName);
  if (!pane) return { resumed: false, reason: "pane_capture_empty" };

  // Guard 1: adapter banner re-confirm.
  const adapter = deps.getAdapter(session.runtimeId);
  const detection = adapter.detectRateLimit(pane);
  if (detection === null) return { resumed: false, reason: "banner_gone" };

  // Guard 2: bottom-line operator-input shape check.
  if (USER_INPUT_BOTTOM_LINE_REGEX.test(lastNonEmptyLine(pane))) {
    return { resumed: false, reason: "input_in_progress" };
  }

  const sent = deps.pressEnter(session.tmuxSessionName);
  if (!sent.ok) {
    return { resumed: false, reason: sent.error ?? "press_enter_failed" };
  }

  const workspace = deps.store
    .listWorkspaces()
    .find((candidate: { id: string }) => candidate.id === session.workspaceId);
  const event: ActivityEvent = {
    id: createId("evt"),
    type: "agent.message",
    source: "system",
    message: `[rate-limit-resumer] Sent wake signal to ${session.displayName}`,
    repoId: workspace?.repoId ?? null,
    workspaceId: session.workspaceId,
    operationId: null,
    hookOutput: null,
    createdAt: now(),
  };
  deps.store.addActivity(event);

  return { resumed: true, reason: "enter_sent" };
}
