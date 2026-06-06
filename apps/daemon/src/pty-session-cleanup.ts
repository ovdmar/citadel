import type { WorkspaceSession } from "@citadel/contracts";
import { connectPtyDaemonClient } from "@citadel/terminal";

export async function closePtyDaemonSession(session: WorkspaceSession): Promise<void> {
  if (session.terminalBackend !== "pty-daemon") return;
  if (!session.ptySessionId) return;
  if (!session.ptyOwnerSocket) return;
  const client = await connectPtyDaemonClient({ socketPath: session.ptyOwnerSocket, timeoutMs: 1000 });
  try {
    client.closeSession(session.ptySessionId);
  } finally {
    client.dispose();
  }
}
