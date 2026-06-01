import type { SqliteStore } from "@citadel/db";
import * as agentHistory from "./agent-history.js";
import * as agentMessages from "./agent-messages.js";

export type SendAgentMessageInput = Parameters<typeof agentMessages.sendAgentMessage>[1];

export const readAgentTranscript = (
  store: SqliteStore,
  input: { sessionId: string; lines?: number; maxChars?: number },
) => agentMessages.readAgentTranscript(store, input);

export const sendAgentMessage = (store: SqliteStore, input: SendAgentMessageInput) =>
  agentMessages.sendAgentMessage(store, input);

export const readAgentHistory = (store: SqliteStore, input: { sessionId: string; limit?: number; maxChars?: number }) =>
  agentHistory.readAgentHistory(store, input);

export const getSessionPromptSummary = (store: SqliteStore, sessionId: string) =>
  agentHistory.getSessionPromptSummary(store, sessionId);
