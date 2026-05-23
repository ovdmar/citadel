import type { ActivityEvent } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { captureTranscript, submitPrompt } from "@citadel/terminal";
import { recordPrompt } from "./agent-history.js";

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

const acceptingStates = new Set(["starting", "running", "waiting", "idle"]);

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
  input: { sessionId: string; message: string },
): Promise<SendMessageResult> {
  const session = store.listSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  if (!session.tmuxSessionName) return { ok: false, error: "session_has_no_terminal" };
  if (!acceptingStates.has(session.status)) {
    return { ok: false, sessionId: session.id, status: session.status, error: "session_not_accepting_input" };
  }
  const result = await submitPrompt(session.tmuxSessionName, input.message);
  if (result.ok) {
    const now = nowIso();
    recordPrompt(store, { sessionId: session.id, source: "send_agent_message", text: input.message, sentAt: now });
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    const event: ActivityEvent = {
      id: createId("evt"),
      type: "agent.message",
      source: "user",
      message: `Sent follow-up message to ${session.displayName}`,
      repoId: workspace?.repoId ?? null,
      workspaceId: session.workspaceId,
      operationId: null,
      hookOutput: null,
      createdAt: now,
    };
    store.addActivity(event);
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
