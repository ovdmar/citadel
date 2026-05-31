// Helpers used by terminal session lifecycle wiring in apps/daemon/src/app.ts.
// Extracted so app.ts stays under the 800-line file-size cap.

import type { CitadelConfig } from "@citadel/config";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { ensureTmuxSession, launchAgentInSession } from "@citadel/terminal";

const SHELL_COMMANDS = ["bash", "sh", "zsh", "fish"] as const;
function isShellCommand(command: string): boolean {
  return (SHELL_COMMANDS as readonly string[]).includes(command);
}

function sessionTmuxName(session: AgentSession, workspaceId: string): string {
  return session.tmuxSessionName ?? `citadel_${workspaceId}_${session.id.slice(-8)}`;
}

function resolveSessionContext(
  store: SqliteStore,
  config: CitadelConfig,
  session: AgentSession,
): {
  workspacePath: string;
  sessionName: string;
  socketName: string | null;
  runtime: CitadelConfig["runtimes"][number];
} | null {
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  const runtime = config.runtimes.find((candidate) => candidate.id === session.runtimeId);
  if (!workspace || !runtime) return null;
  return {
    workspacePath: workspace.path,
    sessionName: sessionTmuxName(session, workspace.id),
    socketName: session.tmuxSocketName ?? null,
    runtime,
  };
}

export function buildRespawnTmux(
  store: SqliteStore,
  config: CitadelConfig,
): (
  session: AgentSession,
) => Promise<{ tmuxSessionName: string; tmuxSessionId: string; tmuxSocketName?: string | null } | null> {
  return async (session) => {
    const ctx = resolveSessionContext(store, config, session);
    if (!ctx) return null;
    const tmux = await ensureTmuxSession({
      sessionName: ctx.sessionName,
      cwd: ctx.workspacePath,
      socketName: ctx.socketName,
    });
    if (!isShellCommand(ctx.runtime.command)) {
      const argv = [...ctx.runtime.args];
      if (session.runtimeSessionId && ctx.runtime.resumeArg) {
        argv.push(ctx.runtime.resumeArg, session.runtimeSessionId);
      }
      await launchAgentInSession(ctx.sessionName, ctx.runtime.command, argv, { socketName: ctx.socketName });
    }
    return tmux;
  };
}
