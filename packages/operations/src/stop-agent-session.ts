import type { ActivityEvent } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";

type ActivityFn = (
  type: string,
  source: ActivityEvent["source"],
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
) => void;

export function stopAgentSession(
  deps: {
    store: SqliteStore;
    terminalHooks: { onSessionStopped?: (sessionId: string) => void };
    activity: ActivityFn;
  },
  input: { sessionId: string },
) {
  const session = deps.store.listSessions().find((candidate) => candidate.id === input.sessionId);
  if (!session) return { stopped: false, reason: "session_not_found" as const };
  if (session.tmuxSessionName) killTmuxSession(session.tmuxSessionName);
  deps.terminalHooks.onSessionStopped?.(session.id);
  deps.store.deleteSession(session.id);
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  deps.activity(
    "agent.stopped",
    "user",
    `Stopped ${session.displayName}`,
    workspace?.repoId ?? null,
    session.workspaceId,
    null,
  );
  return { stopped: true, removed: true, reason: "ok" as const };
}
