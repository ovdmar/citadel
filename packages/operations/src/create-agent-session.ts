import type { AgentSession, CreateAgentSessionInput, Repo, Workspace } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { ensureTmuxSession, submitPrompt } from "@citadel/terminal";

type RuntimeDescriptor = { command: string; args: string[]; displayName: string; promptArg?: string | null };

export type CreateAgentSessionDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
  runNotificationHooks: (
    event: "agent.started",
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: { repo: Repo; workspace: Workspace; session: AgentSession },
  ) => Promise<void>;
};

export async function createAgentSession(
  deps: CreateAgentSessionDeps,
  input: CreateAgentSessionInput,
  runtime: RuntimeDescriptor,
): Promise<AgentSession> {
  const { store } = deps;
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const now = nowIso();
  const sessionName = `citadel_${workspace.id}_${createId("agent").slice(-8)}`;
  // If the runtime exposes a CLI flag for the initial prompt, embed it there;
  // otherwise we paste it into the tmux pane once the TUI is ready (claude-code
  // pattern — input typed before paint gets dropped).
  const runtimeArgs = [...runtime.args];
  let promptForKeys: string | null = null;
  if (input.prompt?.length) {
    if (runtime.promptArg) runtimeArgs.push(runtime.promptArg, input.prompt);
    else promptForKeys = input.prompt;
  }
  const tmux = await ensureTmuxSession({
    sessionName,
    cwd: workspace.path,
    command: runtime.command,
    args: runtimeArgs,
  });
  if (promptForKeys) {
    // Treat the initial prompt as load-bearing: if submitPrompt couldn't
    // verify delivery, the agent will sit on a blank prompt forever, which
    // is exactly the failure mode launch_agent's callers can't recover from.
    // Surface it as an explicit error instead of a phantom success.
    //
    // Tune the cold-start budget by runtime kind. Interactive TUIs (Claude
    // Code with MCP servers connecting, Codex) routinely take 8–15 s before
    // they're ready to accept input. Shell runtimes paint a prompt in
    // milliseconds and `read` is ready instantly; using the TUI budget there
    // makes every test session sit waiting for a 1 s silence threshold that
    // doesn't apply.
    const isShellRuntime = ["bash", "sh", "zsh", "fish"].includes(runtime.command);
    const submitted = await submitPrompt(sessionName, promptForKeys, {
      ...(isShellRuntime
        ? { waitForReadyMs: 1500, submitDelayMs: 800 }
        : {
            waitForReadyMs: 15000,
            submitDelayMs: 3000,
            runtimeReadyPredicate: (cmd) => cmd !== "bash" && cmd !== "sh" && cmd !== "zsh" && cmd.length > 0,
          }),
    });
    if (!submitted.ok) {
      throw new Error(`initial_prompt_not_delivered: ${submitted.error ?? "unknown"}`);
    }
  }
  const session: AgentSession = {
    id: createId("sess"),
    workspaceId: workspace.id,
    runtimeId: input.runtimeId,
    displayName: input.displayName || runtime.displayName,
    status: "running",
    statusReason: "launched",
    lastStatusAt: now,
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    tmuxSessionName: tmux.tmuxSessionName,
    tmuxSessionId: tmux.tmuxSessionId,
    createdAt: now,
    updatedAt: now,
  };
  store.insertSession(session);
  // The runtime records the initial prompt in its own transcript — either
  // because we passed it as a CLI flag (claude-code, codex) or because we
  // pasted it into the tmux pane. read_agent_history surfaces it via the
  // transcript adapter, so we don't double-record it here.
  // When the session was launched by a hook firing, operationId is set so the
  // session's lifecycle activity links back to the operation that triggered it.
  const launchedFromOperation = input.operationId ?? null;
  deps.activity(
    "agent.started",
    "user",
    `Started ${session.displayName}`,
    workspace.repoId,
    workspace.id,
    launchedFromOperation,
  );
  const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (repo)
    await deps.runNotificationHooks("agent.started", repo, workspace, launchedFromOperation, {
      repo,
      workspace,
      session,
    });
  return session;
}
