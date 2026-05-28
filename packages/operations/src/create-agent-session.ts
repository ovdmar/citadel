import { randomUUID } from "node:crypto";
import type { ActivityEvent, AgentSession, CreateAgentSessionInput, Repo, Workspace } from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { discoverCodexSessionId } from "@citadel/runtimes";
import { COMM_TRUNCATION, ensureTmuxSession, launchAgentInSession, submitPrompt } from "@citadel/terminal";

export type RuntimeDescriptor = {
  command: string;
  args: string[];
  displayName: string;
  promptArg?: string | null;
  // CLI flag that pins a caller-chosen session UUID (e.g. "--session-id" for
  // claude-code). When set, createAgentSession generates a UUID, pushes the
  // pair onto argv, and persists it on the row so respawn can `--resume`.
  sessionIdArg?: string | null;
  // CLI flag for resuming a previous conversation by UUID (e.g. "--resume").
  // Used in the restore path when input.resumeRuntimeSessionId is set.
  resumeArg?: string | null;
};

export type CreateAgentSessionDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: ActivityEvent["source"],
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
  options: { activitySource?: ActivityEvent["source"] } = {},
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
  // Pin a UUID at spawn time when the runtime supports it (claude-code's
  // --session-id), so we can resume this exact conversation across daemon/
  // machine restarts. Persisted on AgentSession.runtimeSessionId below.
  // Runtimes without `sessionIdArg` (codex, cursor-agent) need post-spawn
  // discovery from their own session store — handled in a separate path.
  //
  // When the caller passes `resumeRuntimeSessionId` (Settings restore flow /
  // backfill), prefer `--resume <uuid>` over `--session-id <new-uuid>` so we
  // continue the existing conversation rather than fork a fresh one. The
  // caller is responsible for verifying the on-disk transcript exists.
  let runtimeSessionId: string | null = null;
  if (input.resumeRuntimeSessionId && runtime.resumeArg) {
    runtimeSessionId = input.resumeRuntimeSessionId;
    runtimeArgs.push(runtime.resumeArg, input.resumeRuntimeSessionId);
  } else if (runtime.sessionIdArg) {
    runtimeSessionId = randomUUID();
    runtimeArgs.push(runtime.sessionIdArg, runtimeSessionId);
  }
  // Shell-first three-step spawn:
  //  1) ensureTmuxSession  → pane PID is `bash -l` (the operator's shell).
  //  2) launchAgentInSession → send-keys the agent's argv into the shell,
  //     waits for the runtime binary to become pane foreground (positive
  //     predicate matching runtime.command, NOT "not a shell" — transient
  //     subprocesses like direnv during rc-load can't satisfy it).
  //  3) submitPrompt (only when an initial prompt is provided) → paste +
  //     Enter into the runtime's TUI input.
  //
  // For the `shell` runtime, step 2 is a no-op — the shell IS the runtime
  // and is already foreground; calling launchAgentInSession with "bash"
  // would re-launch bash inside the existing bash. Skip it.
  const isShellRuntime = ["bash", "sh", "zsh", "fish"].includes(runtime.command);
  const tmux = await ensureTmuxSession({ sessionName, cwd: workspace.path });
  if (!isShellRuntime) {
    await launchAgentInSession(sessionName, runtime.command, runtimeArgs);
  }
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
    const runtimeBinaryTruncated = runtime.command.slice(0, COMM_TRUNCATION);
    const submitted = await submitPrompt(sessionName, promptForKeys, {
      ...(isShellRuntime
        ? { waitForReadyMs: 1500, submitDelayMs: 800 }
        : {
            waitForReadyMs: 15000,
            submitDelayMs: 3000,
            // POSITIVE predicate: match the runtime's binary name (truncated
            // to `comm`'s 15-char limit) so transient subprocesses claude
            // spawns mid-startup (`git`, `rg`, etc.) cannot satisfy the wait.
            runtimeReadyPredicate: (cmd) => cmd === runtimeBinaryTruncated,
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
    // Restore paths pass the source row's tabId here so the new session lands
    // in the same tab slot. Cold-start spawns generate a fresh time-encoded
    // id — the cockpit sorts tabs by tabId, so first-spawn ordering is
    // identical to ordering by createdAt.
    tabId: input.tabId ?? createId("tab"),
    runtimeSessionId,
    createdAt: now,
    updatedAt: now,
  };
  store.insertSession(session);
  // Codex (and similarly runtimes without `sessionIdArg`) auto-generates its
  // UUID at spawn — we can't pin it via a CLI flag, so kick off a best-effort
  // background poll of ~/.codex/sessions/ to find the rollout this spawn
  // produced, then write its session_meta.id back onto the row. Fire-and-
  // forget: the user's create call returns immediately; the UUID lands in
  // the DB within a few seconds and any subsequent restore picks it up.
  if (!runtimeSessionId && input.runtimeId === "codex") {
    const spawnTimeMs = Date.now();
    void (async () => {
      try {
        const found = await discoverCodexSessionId({ workspacePath: workspace.path, spawnTimeMs });
        if (found) store.setSessionRuntimeSessionId(session.id, found);
      } catch {
        // Discovery is best-effort — codex still works, just isn't resumable
        // until the next spawn picks up an existing rollout.
      }
    })();
  }
  // The runtime records the initial prompt in its own transcript — either
  // because we passed it as a CLI flag (claude-code, codex) or because we
  // pasted it into the tmux pane. read_agent_history surfaces it via the
  // transcript adapter, so we don't double-record it here.
  // When the session was launched by a hook firing, operationId is set so the
  // session's lifecycle activity links back to the operation that triggered it.
  const launchedFromOperation = input.operationId ?? null;
  const activitySource = options.activitySource ?? "user";
  deps.activity(
    "agent.started",
    activitySource,
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
