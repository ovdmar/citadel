import type { AgentPrompt } from "@citadel/contracts";
import { createId } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { findClaudeTranscriptForSession, parseClaudeTranscript } from "@citadel/runtimes";

export type AgentHistoryResult = {
  ok: true;
  sessionId: string;
  workspaceId: string;
  runtimeId: string;
  status: string;
  total: number;
  truncated: boolean;
  prompts: AgentPrompt[];
};

export type AgentHistoryErrorResult = { ok: false; error: "session_not_found" };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_MAX_CHARS = 64_000;
const MAX_MAX_CHARS = 1_000_000;

/**
 * Build the prompt history for a session by merging DB-captured prompts
 * (initial + send_agent_message) with whatever the Claude Code transcript
 * has recorded on disk. Transcript entries win on duplicates so that
 * the canonical text and timestamp come from the runtime's own record.
 *
 * Parsing is on-demand: we read the .jsonl every time history is requested,
 * which keeps the implementation simple and avoids a background poller. The
 * file is small (one line per turn) so the read cost stays bounded.
 */
export function readAgentHistory(
  store: SqliteStore,
  input: { sessionId: string; limit?: number; maxChars?: number },
): AgentHistoryResult | AgentHistoryErrorResult {
  const session = store.listSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  refreshFromTranscript(store, session.id, session.runtimeId, workspace?.path ?? null, session.createdAt);

  const all = store.listAgentPrompts(session.id);
  const limit = clampInt(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxChars = clampInt(input.maxChars, DEFAULT_MAX_CHARS, 256, MAX_MAX_CHARS);
  const trimmed: AgentPrompt[] = [];
  let chars = 0;
  // Walk newest-first so the most recent prompts are always included even
  // when the limit is small.
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const entry = all[i];
    if (!entry) continue;
    const cost = entry.text.length;
    if (trimmed.length >= limit) break;
    if (chars + cost > maxChars && trimmed.length > 0) break;
    trimmed.push(entry);
    chars += cost;
  }
  trimmed.reverse();
  return {
    ok: true,
    sessionId: session.id,
    workspaceId: session.workspaceId,
    runtimeId: session.runtimeId,
    status: session.status,
    total: all.length,
    truncated: trimmed.length < all.length,
    prompts: trimmed,
  };
}

function refreshFromTranscript(
  store: SqliteStore,
  sessionId: string,
  runtimeId: string,
  workspacePath: string | null,
  sessionStartedAt: string,
) {
  if (runtimeId !== "claude-code") return;
  if (!workspacePath) return;
  const transcriptPath = findClaudeTranscriptForSession({ workspacePath, sessionStartedAt });
  if (!transcriptPath) return;
  const prompts = parseClaudeTranscript(transcriptPath);
  if (!prompts.length) return;
  const existing = store.listAgentPrompts(sessionId);
  const existingByExternal = new Map<string, AgentPrompt>();
  const dbCaptured: AgentPrompt[] = [];
  for (const entry of existing) {
    if (entry.externalId) existingByExternal.set(entry.externalId, entry);
    else dbCaptured.push(entry);
  }
  for (const prompt of prompts) {
    if (existingByExternal.has(prompt.uuid)) continue;
    // Prefer the transcript record over an earlier DB-captured duplicate
    // (same text, captured close in time via send_agent_message).
    const duplicate = dbCaptured.findIndex(
      (candidate) => candidate.text === prompt.text && Math.abs(deltaMs(candidate.sentAt, prompt.timestamp)) < 60_000,
    );
    if (duplicate >= 0) {
      const dup = dbCaptured[duplicate];
      if (dup) store.deleteAgentPrompt(dup.id);
      dbCaptured.splice(duplicate, 1);
    }
    store.insertAgentPrompt({
      id: createId("pmt"),
      sessionId,
      source: "transcript",
      role: "user",
      text: prompt.text,
      sentAt: prompt.timestamp,
      externalId: prompt.uuid,
    });
  }
}

function deltaMs(a: string, b: string) {
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  if (!Number.isFinite(aMs) || !Number.isFinite(bMs)) return Number.POSITIVE_INFINITY;
  return aMs - bMs;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
