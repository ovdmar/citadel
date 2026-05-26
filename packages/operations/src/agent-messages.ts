import type { ActivityEvent } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { captureTranscript, submitPrompt } from "@citadel/terminal";
import { reduceStatus } from "./agent-status.js";

// Source of a follow-up submit. Defaults to "user" so existing operator-
// initiated paths (cockpit chat, MCP send_agent_message, CLI) keep their
// historical attribution. Automated callers (auto-resume) pass "system" so
// the cockpit activity log reflects who actually submitted the prompt.
export type SendMessageSource = ActivityEvent["source"];

export type TranscriptResult = {
  ok: true;
  sessionId: string;
  workspaceId: string;
  runtimeId: string;
  status: string;
  tmuxSessionName: string;
  lines: number;
  charCount: number;
  text: string;
};

export type TranscriptErrorResult =
  | { ok: false; error: "session_not_found" }
  | { ok: false; error: "session_has_no_terminal" }
  | ({ ok: false; error: string } & {
      sessionId: string;
      workspaceId: string;
      runtimeId: string;
      status: string;
      tmuxSessionName: string;
    });

export type SendMessageResult = {
  ok: boolean;
  sessionId?: string;
  workspaceId?: string;
  tmuxSessionName?: string;
  status?: string;
  error?: string;
};

const acceptingStates = new Set(["starting", "running", "waiting_for_input", "rate_limited", "usage_limited", "idle"]);

export function readAgentTranscript(
  store: SqliteStore,
  input: { sessionId: string; lines?: number; maxChars?: number },
): TranscriptResult | TranscriptErrorResult {
  const session = store.listSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  if (!session.tmuxSessionName) return { ok: false, error: "session_has_no_terminal" };
  const captureOptions: { lines?: number; maxChars?: number } = {};
  if (input.lines !== undefined) captureOptions.lines = input.lines;
  if (input.maxChars !== undefined) captureOptions.maxChars = input.maxChars;
  const transcript = captureTranscript(session.tmuxSessionName, captureOptions);
  const meta = {
    sessionId: session.id,
    workspaceId: session.workspaceId,
    runtimeId: session.runtimeId,
    status: session.status,
    tmuxSessionName: session.tmuxSessionName,
  };
  if (!transcript.ok) return { ok: false, ...meta, error: transcript.error };
  return { ok: true, ...meta, lines: transcript.lines, charCount: transcript.charCount, text: transcript.text };
}

export async function sendAgentMessage(
  store: SqliteStore,
  input: { sessionId: string; message: string; source?: SendMessageSource; optimistic?: boolean },
): Promise<SendMessageResult> {
  const session = store.listSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  if (!session.tmuxSessionName) return { ok: false, error: "session_has_no_terminal" };
  if (!acceptingStates.has(session.status)) {
    return { ok: false, sessionId: session.id, status: session.status, error: "session_not_accepting_input" };
  }
  const source: SendMessageSource = input.source ?? "user";
  // Optimistic transition defaults to true for human-initiated submits (the
  // cockpit dot flips instantly). Auto-resume opts out: we want the next
  // status-monitor tick to confirm via real pane observation whether the
  // rate-limit banner cleared, so backoff state isn't reset prematurely.
  const optimistic = input.optimistic ?? true;
  const result = await submitPrompt(session.tmuxSessionName, input.message);
  if (result.ok) {
    // We don't record the message here — the runtime's own transcript
    // (claude-code .jsonl, codex rollout, …) captures it whether it arrived
    // through MCP, the cockpit terminal, or a CLI flag. See
    // packages/runtimes/src/transcripts/* for the single source of truth.
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    const event: ActivityEvent = {
      id: createId("evt"),
      type: "agent.message",
      source,
      message: `Sent follow-up message to ${session.displayName}`,
      repoId: workspace?.repoId ?? null,
      workspaceId: session.workspaceId,
      operationId: null,
      hookOutput: null,
      createdAt: nowIso(),
    };
    store.addActivity(event);
    if (
      optimistic &&
      (session.status === "idle" ||
        session.status === "waiting_for_input" ||
        session.status === "rate_limited" ||
        session.status === "usage_limited")
    ) {
      const update = reduceStatus(
        { status: session.status, lastOutputAt: session.lastOutputAt, statusReason: session.statusReason },
        { type: "optimistic_send" },
        nowIso,
      );
      if (update) {
        store.updateSessionStatus(session.id, {
          status: update.status,
          ...(update.reason !== undefined ? { statusReason: update.reason } : {}),
          ...(update.lastStatusAt !== undefined ? { lastStatusAt: update.lastStatusAt } : {}),
        });
      }
    }
  }
  const response: SendMessageResult = {
    ok: result.ok,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    tmuxSessionName: session.tmuxSessionName,
  };
  if (result.error !== undefined) response.error = result.error;
  return response;
}
