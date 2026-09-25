import type { AgentPrompt } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { codexHomeForWorkspace, getUserPromptsForSession } from "@citadel/runtimes";

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

export type AgentHistoryErrorResult = { ok: false; error: "session_not_found" | "session_not_agent" };

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 2000;
const DEFAULT_MAX_CHARS = 64_000;
const MAX_MAX_CHARS = 1_000_000;

/**
 * Build the prompt history for a session by dispatching to the per-runtime
 * transcript adapter (claude-code .jsonl, codex rollout, …). Citadel does
 * not persist prompts itself — the adapter is the single source of truth, so
 * MCP follow-ups, terminal typing, and CLI-flag initial prompts all surface
 * uniformly. Parsing is on demand and deterministic; no LLM calls.
 */
export function readAgentHistory(
  store: SqliteStore,
  input: { sessionId: string; limit?: number; maxChars?: number },
): AgentHistoryResult | AgentHistoryErrorResult {
  const session = store.listWorkspaceSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { ok: false, error: "session_not_found" };
  if (session.kind !== "agent") return { ok: false, error: "session_not_agent" };
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  const all: AgentPrompt[] = workspace
    ? getUserPromptsForSession({
        runtimeId: session.runtimeId,
        workspacePath: workspace.path,
        sessionStartedAt: session.createdAt,
        ...(session.runtimeId === "codex" ? { codexHome: codexHomeForWorkspace(session.workspaceId) } : {}),
      })
    : [];
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

/**
 * Returns `{ initialPrompt, messageCount }` for a session by tapping the
 * same adapter the history endpoint uses. Used by `list_agent_sessions` to
 * surface a quick summary alongside each session row.
 */
export function getSessionPromptSummary(
  store: SqliteStore,
  sessionId: string,
): { initialPrompt: string | null; messageCount: number } {
  const session = store.listWorkspaceSessions().find((candidate) => candidate.id === sessionId);
  if (!session) return { initialPrompt: null, messageCount: 0 };
  if (session.kind !== "agent") return { initialPrompt: null, messageCount: 0 };
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  if (!workspace) return { initialPrompt: null, messageCount: 0 };
  const prompts = getUserPromptsForSession({
    runtimeId: session.runtimeId,
    workspacePath: workspace.path,
    sessionStartedAt: session.createdAt,
    ...(session.runtimeId === "codex" ? { codexHome: codexHomeForWorkspace(session.workspaceId) } : {}),
  });
  return {
    initialPrompt: prompts[0]?.text ?? null,
    messageCount: prompts.length,
  };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
