import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAgentAdapter } from "./cursor-agent.js";
import type { GetUserPromptsInput, RuntimeTranscriptAdapter, RuntimeUserPrompt } from "./types.js";

export type { GetUserPromptsInput, RuntimeTranscriptAdapter, RuntimeUserPrompt } from "./types.js";
export {
  claudeCodeAdapter,
  claudeProjectsDir,
  findClaudeTranscriptForSession,
  parseClaudeTranscript,
  renderClaudeTranscriptAsText,
} from "./claude-code.js";
export { codexAdapter, codexSessionsRoot, findCodexRolloutForSession, parseCodexRollout } from "./codex.js";
export { cursorAgentAdapter } from "./cursor-agent.js";

const adapters: Record<string, RuntimeTranscriptAdapter> = {
  [claudeCodeAdapter.runtimeId]: claudeCodeAdapter,
  [codexAdapter.runtimeId]: codexAdapter,
  [cursorAgentAdapter.runtimeId]: cursorAgentAdapter,
};

export function getTranscriptAdapter(runtimeId: string): RuntimeTranscriptAdapter | null {
  return adapters[runtimeId] ?? null;
}

/**
 * Resolve the user-authored prompts captured by the runtime for a given
 * Citadel session. Returns an empty array for runtimes without an adapter
 * (e.g. `shell`) — those sessions don't have a persisted transcript and
 * prompt history is inherently unavailable for them.
 */
export function getUserPromptsForSession(input: {
  runtimeId: string;
  workspacePath: string;
  sessionStartedAt: string;
  home?: string;
}): RuntimeUserPrompt[] {
  const adapter = getTranscriptAdapter(input.runtimeId);
  if (!adapter) return [];
  const params: GetUserPromptsInput = {
    workspacePath: input.workspacePath,
    sessionStartedAt: input.sessionStartedAt,
  };
  if (input.home !== undefined) params.home = input.home;
  return adapter.getUserPrompts(params);
}
