import type { WorkspaceSession } from "@citadel/contracts";

export type ClosePtySession = (session: WorkspaceSession) => Promise<void> | void;

export function closePtySessionBestEffort(closePtySession: ClosePtySession | undefined, session: WorkspaceSession) {
  if (session.terminalBackend !== "pty-daemon" || !closePtySession) return;
  void Promise.resolve(closePtySession(session)).catch(() => undefined);
}
