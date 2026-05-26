import type { CitadelConfig } from "@citadel/config";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { ensureTmuxSession } from "@citadel/terminal";

// Closure factory so app.ts can hand a single bound function to
// registerTerminalRoutes without dragging the runtime lookup inline (which
// pushed app.ts over the 800-LOC cap).
export function makeRespawnTmux(deps: { store: SqliteStore; config: CitadelConfig }) {
  return async (session: AgentSession) => {
    const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    const runtime = deps.config.runtimes.find((candidate) => candidate.id === session.runtimeId);
    if (!workspace || !runtime) return null;
    const sessionName = session.tmuxSessionName ?? `citadel_${workspace.id}_${session.id.slice(-8)}`;
    const { command, args, id: runtimeId } = runtime;
    return ensureTmuxSession({ sessionName, cwd: workspace.path, command, args, runtimeId });
  };
}
