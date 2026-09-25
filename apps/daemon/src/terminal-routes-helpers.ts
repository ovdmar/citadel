// Helpers used by terminal session lifecycle wiring in apps/daemon/src/app.ts.
// Extracted so app.ts stays under the 800-line file-size cap.

import { type AgentRuntimeConfig, type CitadelConfig, ensureCodexGoalsFeatureArgs } from "@citadel/config";
import type { AgentSession, WorkspaceSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { prepareCodexHomeForWorkspace } from "@citadel/runtimes";
import { ensureTmuxSession, launchAgentInSession, panePidProcess } from "@citadel/terminal";

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
): {
  workspacePath: string;
  sessionName: string;
  socketName: string | null;
  runtime: AgentRuntimeConfig | null;
} | null {
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
  let runtime: AgentRuntimeConfig | null = null;
  if (session.kind === "agent") {
    runtime = config.agentRuntimes.find((candidate) => candidate.id === session.runtimeId) ?? null;
  }
  if (!workspace || (session.kind === "agent" && !runtime)) return null;
  return {
    workspacePath: workspace.path,
    sessionName: sessionTmuxName(session, workspace.id),
    socketName: session.tmuxSocketName ?? null,
    runtime,
  };
}

function codexEnvForSession(
  session: AgentSession,
  _config: CitadelConfig,
): Record<string, string | null | undefined> | undefined {
  if (session.runtimeId !== "codex") return undefined;
  const codexHome = prepareCodexHomeForWorkspace({ workspaceId: session.workspaceId });
  return {
    CODEX_HOME: codexHome.home,
    CODEX_SQLITE_HOME: codexHome.sqliteHome,
  };
}

export function buildRespawnTmux(
  store: SqliteStore,
  config: CitadelConfig,
): (
  session: WorkspaceSession,
) => Promise<{ tmuxSessionName: string; tmuxSessionId: string; tmuxSocketName?: string | null } | null> {
  return async (session) => {
    const ctx = resolveSessionContext(store, config, session);
    if (!ctx) return null;
    const tmux = await ensureTmuxSession({
      sessionName: ctx.sessionName,
      cwd: ctx.workspacePath,
      socketName: ctx.socketName,
      terminal: config.terminal,
    });
    if (session.kind === "agent" && ctx.runtime && !isShellCommand(ctx.runtime.command)) {
      const argv = ensureCodexGoalsFeatureArgs(session.runtimeId, ctx.runtime.args);
      if (session.runtimeSessionId && ctx.runtime.resumeArg) {
        argv.push(ctx.runtime.resumeArg, session.runtimeSessionId);
      }
      const env = codexEnvForSession(session, config);
      await launchAgentInSession(ctx.sessionName, ctx.runtime.command, argv, {
        socketName: ctx.socketName,
        exitHint: { runtimeId: session.runtimeId, runtimeSessionId: session.runtimeSessionId ?? null },
        ...(env ? { env } : {}),
      });
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
    if (!ctx || !ctx.runtime) throw new Error("session_resolution_failed");
    const pane = panePidProcess(ctx.sessionName, ctx.socketName);
    if (pane && pane.command === ctx.runtime.command.slice(0, 15)) {
      throw new Error("agent_already_running");
    }
    await ensureTmuxSession({
      sessionName: ctx.sessionName,
      cwd: ctx.workspacePath,
      socketName: ctx.socketName,
      terminal: config.terminal,
    });
    if (!isShellCommand(ctx.runtime.command)) {
      const argv = ensureCodexGoalsFeatureArgs(session.runtimeId, ctx.runtime.args);
      if (session.runtimeSessionId && ctx.runtime.resumeArg) {
        argv.push(ctx.runtime.resumeArg, session.runtimeSessionId);
      }
      const env = codexEnvForSession(session, config);
      await launchAgentInSession(ctx.sessionName, ctx.runtime.command, argv, {
        socketName: ctx.socketName,
        exitHint: { runtimeId: session.runtimeId, runtimeSessionId: session.runtimeSessionId ?? null },
        ...(env ? { env } : {}),
      });
    }
    store.updateSessionStatus(session.id, {
      status: "running",
      statusReason: null,
      statusReasonAt: null,
      lastStatusAt: new Date().toISOString(),
    });
  };
}
