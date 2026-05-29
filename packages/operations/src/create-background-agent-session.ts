import type { ActivityEvent, BackgroundAgentSession } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { ensureTmuxSessionRaw, killTmuxSession, pipeBackgroundSessionToLog, submitPrompt } from "@citadel/terminal";

type RuntimeDescriptor = { command: string; args: string[]; displayName: string; promptArg: string | null };

export type CreateBackgroundAgentSessionDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
};

export type CreateBackgroundAgentSessionInput = {
  cwd: string;
  runtimeId: string;
  runtime: RuntimeDescriptor;
  prompt?: string;
  scheduledAgentId: string;
  logFilePath: string;
};

/**
 * Spawn a tmux pane in `cwd` for a scheduled-agent background run, start
 * streaming its output to `logFilePath`, and persist the session row.
 *
 * No fallback wrapper: when the agent exits, the pane terminates. The
 * reconciler will see `tmuxSessionExists === false` on its next tick and
 * close the matching run row.
 *
 * If anything after `ensureTmuxSessionRaw` throws, the tmux session is
 * killed so we don't leak an orphan pane.
 */
export async function createBackgroundAgentSession(
  deps: CreateBackgroundAgentSessionDeps,
  input: CreateBackgroundAgentSessionInput,
): Promise<BackgroundAgentSession> {
  const sessionName = `citadel_bg_${createId("bgagent").slice(-8)}`;
  // Embed prompt as a CLI arg if the runtime supports it (claude-code, codex);
  // otherwise paste it into the pane once tmux is ready. Mirrors
  // createAgentSession's logic.
  const runtimeArgs = [...input.runtime.args];
  let promptForKeys: string | null = null;
  if (input.prompt?.length) {
    if (input.runtime.promptArg) runtimeArgs.push(input.runtime.promptArg, input.prompt);
    else promptForKeys = input.prompt;
  }

  let tmux: { tmuxSessionName: string; tmuxSessionId: string };
  try {
    tmux = await ensureTmuxSessionRaw({
      sessionName,
      cwd: input.cwd,
      command: input.runtime.command,
      args: runtimeArgs,
    });
  } catch (error) {
    // Best-effort cleanup: kill the session if it half-spawned.
    try {
      killTmuxSession(sessionName);
    } catch {
      // ignore
    }
    throw error;
  }

  try {
    pipeBackgroundSessionToLog(tmux.tmuxSessionName, input.logFilePath);
    if (promptForKeys) await submitPrompt(tmux.tmuxSessionName, promptForKeys);
  } catch (error) {
    try {
      killTmuxSession(sessionName);
    } catch {
      // ignore
    }
    throw error;
  }

  const now = nowIso();
  const session: BackgroundAgentSession = {
    id: createId("bgsess"),
    scheduledAgentId: input.scheduledAgentId,
    cwd: input.cwd,
    logFilePath: input.logFilePath,
    tmuxSessionName: tmux.tmuxSessionName,
    tmuxSessionId: tmux.tmuxSessionId,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };
  try {
    deps.store.insertBackgroundSession(session);
  } catch (error) {
    try {
      killTmuxSession(sessionName);
    } catch {
      // ignore
    }
    throw error;
  }
  deps.activity(
    "agent.started.background",
    "system",
    `Started ${input.runtime.displayName} (background) in ${input.cwd}`,
    null,
    null,
    null,
  );
  return session;
}
