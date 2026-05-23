import type { RuntimeTranscriptAdapter } from "./types.js";

/**
 * cursor-agent transcript format is not yet wired up.
 *
 * The Cursor CLI does persist chats, but the on-disk layout differs by
 * platform and version and was not present on the reference machine when
 * this adapter was authored. We expose the slot so `read_agent_history` and
 * `list_agent_sessions` still resolve cleanly for `cursor-agent` sessions;
 * they just return empty until the parser lands.
 *
 * To enable: implement `getUserPrompts(input)` returning the user-authored
 * entries from cursor-agent's per-session log for the given `workspacePath`
 * and `sessionStartedAt`. Apply the same mtime / start-window pre-filter as
 * claude-code and codex adapters.
 *
 * Tracked alongside the broader runtime-session-uuid follow-up in #17.
 */
export const cursorAgentAdapter: RuntimeTranscriptAdapter = {
  runtimeId: "cursor-agent",
  getUserPrompts() {
    return [];
  },
};
