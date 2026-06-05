import type { AgentSession, WorkspaceSession } from "@citadel/contracts";

type TerminalBackendInputKeys = "terminalBackend" | "ptySessionId" | "ptyOwnerSocket" | "ptyOwnerPid" | "ptyLastSeenAt";
type TerminalBackendInput = Partial<Pick<WorkspaceSession, TerminalBackendInputKeys>>;

export type LegacyAgentSessionInput = Omit<AgentSession, "kind" | TerminalBackendInputKeys> &
  TerminalBackendInput & {
    kind?: "agent";
  };
export type WorkspaceSessionInput =
  | (Omit<WorkspaceSession, TerminalBackendInputKeys> & TerminalBackendInput)
  | LegacyAgentSessionInput;
