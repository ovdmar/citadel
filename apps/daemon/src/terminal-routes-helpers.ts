// Helpers used by terminal-routes wiring in apps/daemon/src/app.ts.
// Extracted so app.ts stays under the 800-line file-size cap.

import type http from "node:http";
import type { AgentRuntimeConfig, CitadelConfig } from "@citadel/config";
import type { AgentSession, WorkspaceSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type TtydManager, ensureTmuxSession, launchAgentInSession, panePidProcess } from "@citadel/terminal";
import type express from "express";
import { registerTerminalRoutes } from "./terminal-routes.js";

type DiagnosticsSink = {
  log(category: string, event: string, data?: Record<string, unknown>): void;
};

const SHELL_COMMANDS = ["bash", "sh", "zsh", "fish"] as const;
function isShellCommand(command: string): boolean {
  return (SHELL_COMMANDS as readonly string[]).includes(command);
}

function sessionTmuxName(session: WorkspaceSession, workspaceId: string): string {
  return session.tmuxSessionName ?? `citadel_${workspaceId}_${session.id.slice(-8)}`;
}

function resolveSessionContext(
  store: SqliteStore,
  config: CitadelConfig,
  session: WorkspaceSession,
): { workspacePath: string; sessionName: string; runtime: AgentRuntimeConfig | null } | null {
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  let runtime: AgentRuntimeConfig | null = null;
  if (session.kind === "agent") {
    runtime = config.agentRuntimes.find((candidate) => candidate.id === session.runtimeId) ?? null;
  }
  if (!workspace || (session.kind === "agent" && !runtime)) return null;
  return { workspacePath: workspace.path, sessionName: sessionTmuxName(session, workspace.id), runtime };
}

// Recreate the tmux session a tab needs after operator reconnect. Agent tabs
// spawn the configured terminal profile and then launch the agent runtime;
// terminal tabs only spawn the terminal profile.
// Wire the terminal-routes + supporting helpers in one call. Returns the
// shared recentUserAction map so the status-monitor wiring (separate file)
// can read it by reference. Keeping the wiring in this helper module
// rather than inline in app.ts saves the 800-line file-size cap.
export function wireTerminalRoutes(input: {
  app: express.Express;
  server: http.Server;
  store: SqliteStore;
  ttyd: TtydManager;
  dataDir: string;
  emit: (type: string, payload: unknown) => void;
  config: CitadelConfig;
  diagnostics?: DiagnosticsSink;
}): { recentUserAction: Map<string, number> } {
  const recentUserAction = new Map<string, number>();
  registerTerminalRoutes({
    app: input.app,
    server: input.server,
    store: input.store,
    ttyd: input.ttyd,
    dataDir: input.dataDir,
    emit: input.emit,
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    recentUserAction,
    respawnTmux: buildRespawnTmux(input.store, input.config),
    restartAgent: buildRestartAgent(input.store, input.config),
  });
  return { recentUserAction };
}

export function buildRespawnTmux(
  store: SqliteStore,
  config: CitadelConfig,
): (session: WorkspaceSession) => Promise<{ tmuxSessionName: string; tmuxSessionId: string } | null> {
  return async (session) => {
    const ctx = resolveSessionContext(store, config, session);
    if (!ctx) return null;
    const tmux = await ensureTmuxSession({
      sessionName: ctx.sessionName,
      cwd: ctx.workspacePath,
      terminal: config.terminal,
    });
    if (session.kind === "agent" && ctx.runtime && !isShellCommand(ctx.runtime.command)) {
      const argv = [...ctx.runtime.args];
      if (session.runtimeSessionId && ctx.runtime.resumeArg) {
        argv.push(ctx.runtime.resumeArg, session.runtimeSessionId);
      }
      await launchAgentInSession(ctx.sessionName, ctx.runtime.command, argv);
    }
    return tmux;
  };
}

// Restart endpoint: relaunches the agent inside an existing pane. Throws
// `agent_already_running` when the pane's foreground IS the runtime binary
// (stale UI / race) so we don't type the launch command INTO the live TUI
// input. Otherwise composes the shell-first three-step and clears
// statusReason/statusReasonAt so the cockpit doesn't briefly show a stale
// idle_after_unexpected_exit label.
export function buildRestartAgent(store: SqliteStore, config: CitadelConfig): (session: AgentSession) => Promise<void> {
  return async (session) => {
    const ctx = resolveSessionContext(store, config, session);
    if (!ctx) throw new Error("session_resolution_failed");
    if (!ctx.runtime) throw new Error("session_not_agent");
    const pane = panePidProcess(ctx.sessionName);
    if (pane && pane.command === ctx.runtime.command.slice(0, 15)) {
      throw new Error("agent_already_running");
    }
    await ensureTmuxSession({ sessionName: ctx.sessionName, cwd: ctx.workspacePath, terminal: config.terminal });
    if (!isShellCommand(ctx.runtime.command)) {
      const argv = [...ctx.runtime.args];
      if (session.runtimeSessionId && ctx.runtime.resumeArg) {
        argv.push(ctx.runtime.resumeArg, session.runtimeSessionId);
      }
      await launchAgentInSession(ctx.sessionName, ctx.runtime.command, argv);
    }
    store.updateSessionStatus(session.id, {
      status: "running",
      statusReason: null,
      statusReasonAt: null,
      lastStatusAt: new Date().toISOString(),
    });
  };
}
