import type { AgentSession, WorkspaceSession } from "@citadel/contracts";

type TerminalBackendInputKeys = "terminalBackend" | "ptySessionId" | "ptyOwnerSocket" | "ptyOwnerPid" | "ptyLastSeenAt";
type TerminalBackendInput = Partial<Pick<WorkspaceSession, TerminalBackendInputKeys>>;
type InternalSystemPromptInput = { systemPromptSnapshot?: string | null };

export type LegacyAgentSessionInput = Omit<AgentSession, "kind" | TerminalBackendInputKeys> &
  TerminalBackendInput &
  InternalSystemPromptInput & {
    kind?: "agent";
  };
export type WorkspaceSessionInput =
  | (Omit<WorkspaceSession, TerminalBackendInputKeys> & TerminalBackendInput & InternalSystemPromptInput)
  | LegacyAgentSessionInput;
