/**
 * A single user-authored prompt extracted from a runtime's own transcript.
 *
 * Citadel relies on the runtime's transcript as the canonical record of what
 * the user told the agent — pasted text, terminal-typed input, and initial
 * prompts all surface the same way. There is no Citadel-side intercept of
 * follow-ups; the adapter is the single source of truth.
 */
export type RuntimeUserPrompt = {
  /** The runtime's own message id (e.g. claude uuid, codex turn_id, ...). Used for dedup and ordering. */
  externalId: string;
  /** Plain text the user sent. */
  text: string;
  /** ISO 8601 timestamp the runtime recorded for the message. */
  sentAt: string;
};

/**
 * Adapter contract: given a workspace path and a Citadel session start time,
 * return the ordered list of user-authored prompts the runtime captured for
 * that session. Adapters are pure / deterministic — no LLM calls, no network.
 */
export type RuntimeTranscriptAdapter = {
  runtimeId: string;
  /**
   * Locate and parse the transcript(s) belonging to a session that started
   * inside `workspacePath` at `sessionStartedAt`. The adapter is responsible
   * for filename / metadata heuristics specific to its runtime.
   *
   * Returns an empty array when no transcript can be confidently matched.
   */
  getUserPrompts: (input: GetUserPromptsInput) => RuntimeUserPrompt[];
};

export type GetUserPromptsInput = {
  workspacePath: string;
  sessionStartedAt: string;
  /** Override `os.homedir()` — set by tests. */
  home?: string;
  /** Codex-specific override for CODEX_HOME. */
  codexHome?: string;
};
