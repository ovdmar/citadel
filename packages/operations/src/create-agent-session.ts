import { randomUUID } from "node:crypto";
import { ensureCodexGoalsFeatureArgs } from "@citadel/config";
import type {
  ActivityEvent,
  AgentSession,
  CreateAgentSessionInput,
  CreateTerminalSessionInput,
  ExecutionTarget,
  JiraAutoTransitionEvent,
  Repo,
  TerminalProfile,
  Workspace,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import {
  type RuntimeLaunchOptionsInput,
  codexHomeForWorkspace,
  discoverCodexSessionId,
  prepareCodexSqliteHomeForWorkspace,
  resolveRuntimeLaunchProfile,
} from "@citadel/runtimes";
import {
  type AgentExitHint,
  COMM_TRUNCATION,
  captureTranscript,
  ensureTmuxSession,
  killTmuxSession,
  launchAgentInSession,
  panePidProcess,
  submitPrompt,
  tmuxSocketNameForWorkspace,
} from "@citadel/terminal";
import {
  type CreateAgentSessionOperationInput,
  renderSystemPromptFallbackMessage,
  resolveSystemPromptLaunch,
} from "./system-prompt-launch.js";
import { executionTargetCwd } from "./workspace-layout.js";

const CODEX_STATE_DB_LOCKED = /(?:database is locked|failed to initialize state runtime)/i;
const CODEX_LAUNCH_MAX_ATTEMPTS = 5;
const CODEX_LAUNCH_STABILITY_MS = 1200;

let codexLaunchQueue: Promise<void> = Promise.resolve();

type RuntimeLaunchEnv = Record<string, string | null | undefined>;
type RuntimeLaunchOptions = { exitHint: AgentExitHint; env?: RuntimeLaunchEnv };

export type RuntimeDescriptor = {
  id?: string;
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
  launchOptions?: RuntimeLaunchOptionsInput;
};

export type CreateAgentSessionDeps = {
  store: SqliteStore;
  terminal?: TerminalProfile | undefined;
  dataDir?: string;
  baseSystemPrompt?: string;
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
  ) => Promise<unknown>;
  // Optional — daemon constructs this via createJiraAutoTransitions. Null
  // when no Jira provider is wired (e.g., in unit tests that don't
  // exercise the integration). Failures inside are swallowed; never throw.
  runAutoTransitions?:
    | ((
        event: JiraAutoTransitionEvent,
        repo: Repo,
        workspace: Workspace,
        payload: { repo: Repo; workspace: Workspace; session: AgentSession },
      ) => Promise<void>)
    | null;
};

const DEFAULT_TERMINAL_PROFILE: TerminalProfile = { displayName: "Terminal", command: "bash", args: ["-l"] };

export async function createAgentSession(
  deps: CreateAgentSessionDeps,
  input: CreateAgentSessionOperationInput,
  runtime: RuntimeDescriptor,
  options: { activitySource?: ActivityEvent["source"] } = {},
): Promise<AgentSession> {
  const { store } = deps;
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const checkout = input.checkoutId ? store.findWorkspaceCheckout(input.checkoutId) : null;
  if (input.checkoutId && !checkout) throw new Error(`Unknown checkout: ${input.checkoutId}`);
  if (checkout && checkout.workspaceId !== workspace.id) {
    throw new Error(`Checkout ${checkout.id} does not belong to workspace ${workspace.id}`);
  }
  const targetType =
    input.targetType ??
    (checkout ? "worktree_checkout" : workspace.mode === "structured" ? "workspace_home" : "worktree_checkout");
  const cwd = resolveSessionCwd({ workspace, checkout, targetType });
  const now = nowIso();
  const sessionName = `citadel_${workspace.id}_${createId("agent").slice(-8)}`;
  const tmuxSocketName = tmuxSocketNameForWorkspace(workspace.id);
  // Prefer runtime-native initial-prompt argv when available. Codex accepts
  // the prompt as a positional argument; Claude Code's interactive mode does
  // not, so for runtimes without argv support we paste once the TUI is ready.
  const launchProfile = resolveRuntimeLaunchProfile({
    runtime: {
      id: runtime.id ?? input.runtimeId,
      command: runtime.command,
      args: ensureCodexGoalsFeatureArgs(input.runtimeId, runtime.args),
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? undefined,
      sessionIdArg: runtime.sessionIdArg ?? undefined,
      resumeArg: runtime.resumeArg ?? undefined,
      launchOptions: runtime.launchOptions,
    },
    settings: input.launchSettings,
  });
  const systemPromptLaunch = resolveSystemPromptLaunch({
    store,
    workspaceId: workspace.id,
    runtimeId: input.runtimeId,
    resumeRuntimeSessionId: input.resumeRuntimeSessionId,
    resumeSourceSessionId: input.resumeSourceSessionId,
    baseSystemPrompt: deps.baseSystemPrompt ?? "",
    roleTemplatePrompt: input.roleTemplatePrompt,
    callerPrompt: input.systemPrompt,
    mode: input.systemPromptMode,
    runtimeArgs: launchProfile.args,
    launchWarnings: launchProfile.launchWarnings,
    systemPromptArgv: launchProfile.runtime.launchOptions?.systemPromptArgv,
    operationInput: input,
    runtime,
  });
  const systemPromptState = systemPromptLaunch.state;
  const runtimeArgs = [...systemPromptLaunch.runtimeArgs];
  const launchWarnings = [...systemPromptLaunch.launchWarnings];
  const systemPromptDelivery = systemPromptLaunch.systemPromptDelivery;
  const systemPromptLastDelivery = systemPromptLaunch.systemPromptLastDelivery;
  let promptForKeys: string | null = null;
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
  if (systemPromptLaunch.shouldUseFallbackSystemPrompt && systemPromptState.value) {
    promptForKeys = renderSystemPromptFallbackMessage(systemPromptState.value, input.prompt ?? null);
  } else if (input.prompt?.length) {
    if (runtime.promptArg) runtimeArgs.push(runtime.promptArg, input.prompt);
    else if (input.runtimeId === "codex") runtimeArgs.push(input.prompt);
    else promptForKeys = input.prompt;
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
  const codexSqliteHome =
    input.runtimeId === "codex" ? prepareCodexSqliteHomeForWorkspace({ workspaceId: workspace.id }) : null;
  const runtimeEnv = codexSqliteHome ? { CODEX_HOME: null, CODEX_SQLITE_HOME: codexSqliteHome } : undefined;
  let tmux: Awaited<ReturnType<typeof ensureTmuxSession>>;
  let runtimeLaunchStartedMs: number | null = null;
  try {
    tmux = await ensureTmuxSession({
      sessionName,
      cwd,
      socketName: tmuxSocketName,
      terminal: deps.terminal ?? DEFAULT_TERMINAL_PROFILE,
    });
    if (!isShellRuntime) {
      const exitHint: AgentExitHint = { runtimeId: input.runtimeId, runtimeSessionId };
      const launchOptions: RuntimeLaunchOptions = { exitHint };
      if (runtimeEnv !== undefined) launchOptions.env = runtimeEnv;
      runtimeLaunchStartedMs =
        input.runtimeId === "codex"
          ? await withCodexLaunchLock(() =>
              launchCodexWithRetry(sessionName, tmuxSocketName, runtime.command, runtimeArgs, launchOptions),
            )
          : await launchRuntimeOnce(sessionName, tmuxSocketName, runtime.command, runtimeArgs, launchOptions);
    }
    if (promptForKeys) {
      // Treat the initial prompt as load-bearing: if submitPrompt couldn't
      // verify delivery, the agent will sit on a blank prompt forever, which
      // is exactly the failure mode launch_agent's callers can't recover from.
      // Surface it as an explicit error instead of a phantom success.
      //
      // Tune the cold-start budget by runtime kind. Interactive TUIs (Claude
      // Code with MCP servers connecting, Codex) routinely take 8–15 s before
      // they're ready to accept input. Shell-like custom runtimes paint a prompt in
      // milliseconds and `read` is ready instantly; using the TUI budget there
      // makes every test session sit waiting for a 1 s silence threshold that
      // doesn't apply.
      const runtimeBinaryTruncated = runtime.command.slice(0, COMM_TRUNCATION);
      const submitted = await submitPrompt(sessionName, promptForKeys, {
        socketName: tmuxSocketName,
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
  } catch (error) {
    killTmuxSession(sessionName, tmuxSocketName);
    throw error;
  }
  const session: AgentSession = {
    id: createId("sess"),
    kind: "agent",
    workspaceId: workspace.id,
    runtimeId: input.runtimeId,
    displayName: input.displayName || runtime.displayName,
    targetType,
    checkoutId: input.checkoutId ?? null,
    role: input.role ?? null,
    actionId: input.actionId ?? null,
    managed: input.managed ?? false,
    parentSessionId: input.parentSessionId ?? null,
    planVersionId: input.planVersionId ?? null,
    managerActionId: input.managerActionId ?? null,
    status: "running",
    statusReason: "launched",
    lastStatusAt: now,
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    terminalBackend: "tmux",
    tmuxSessionName: tmux.tmuxSessionName,
    tmuxSessionId: tmux.tmuxSessionId,
    tmuxSocketName,
    ptySessionId: null,
    ptyOwnerSocket: null,
    ptyOwnerPid: null,
    ptyLastSeenAt: null,
    // Restore paths pass the source row's tabId here so the new session lands
    // in the same tab slot. Cold-start spawns generate a fresh time-encoded
    // id — the cockpit sorts tabs by tabId, so first-spawn ordering is
    // identical to ordering by createdAt.
    tabId: input.tabId ?? createId("tab"),
    runtimeSessionId,
    systemPromptSources: systemPromptState.sources,
    systemPromptDelivery,
    systemPromptLastDelivery,
    launchWarnings,
    createdAt: now,
    updatedAt: now,
  };
  store.insertSession({ ...session, systemPromptSnapshot: systemPromptState.snapshot });
  // Codex (and similarly runtimes without `sessionIdArg`) auto-generates its
  // UUID at spawn — we can't pin it via a CLI flag, so kick off a best-effort
  // background poll of the live Codex process / ~/.codex/sessions/ to find
  // the rollout this spawn produced, then write its session_meta.id back
  // onto the row. Fire-and-forget: the user's create call returns
  // immediately; the status monitor can repair the row later if this misses.
  if (!runtimeSessionId && input.runtimeId === "codex") {
    const paneRootPid = panePidProcess(sessionName, tmuxSocketName)?.pid;
    const spawnTimeMs = runtimeLaunchStartedMs ?? Date.now();
    void (async () => {
      try {
        const found = await discoverCodexSessionId({
          workspacePath: cwd,
          spawnTimeMs,
          timeoutMs: 120_000,
          ...(paneRootPid ? { rootPid: paneRootPid } : {}),
          ...(codexSqliteHome ? { codexHome: codexHomeForWorkspace(workspace.id) } : {}),
        });
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
  for (const warning of launchWarnings) {
    deps.activity(
      "agent.launch_warning",
      activitySource,
      warning,
      workspace.repoId,
      workspace.id,
      launchedFromOperation,
    );
  }
  const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (repo) {
    await deps.runNotificationHooks("agent.started", repo, workspace, launchedFromOperation, {
      repo,
      workspace,
      session,
    });
    // Auto-transitions never block session start — the callback wraps its
    // own try/catch but be paranoid here too in case a bad injection
    // throws synchronously before the callback's wrapper runs.
    if (deps.runAutoTransitions) {
      try {
        await deps.runAutoTransitions("agent.started", repo, workspace, { repo, workspace, session });
      } catch {
        // Already logged inside the callback via activity events.
      }
    }
  }
  return session;
}

export async function createTerminalSession(
  deps: Pick<CreateAgentSessionDeps, "store" | "activity" | "terminal">,
  input: CreateTerminalSessionInput,
  options: { activitySource?: ActivityEvent["source"] } = {},
): Promise<WorkspaceSession> {
  const { store } = deps;
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const checkout = input.checkoutId ? store.findWorkspaceCheckout(input.checkoutId) : null;
  if (input.checkoutId && !checkout) throw new Error(`Unknown checkout: ${input.checkoutId}`);
  if (checkout && checkout.workspaceId !== workspace.id) {
    throw new Error(`Checkout ${checkout.id} does not belong to workspace ${workspace.id}`);
  }
  const targetType =
    input.targetType ??
    (checkout ? "worktree_checkout" : workspace.mode === "structured" ? "workspace_home" : "worktree_checkout");
  const cwd = resolveSessionCwd({ workspace, checkout, targetType });
  const now = nowIso();
  const terminal = deps.terminal ?? DEFAULT_TERMINAL_PROFILE;
  const terminalBackend = configuredTerminalBackend();
  const sessionId = createId("sess");
  const sessionName = `citadel_${workspace.id}_${createId("term").slice(-8)}`;
  const tmuxSocketName = tmuxSocketNameForWorkspace(workspace.id);
  let tmux: Awaited<ReturnType<typeof ensureTmuxSession>> | null = null;
  if (terminalBackend === "tmux") {
    try {
      tmux = await ensureTmuxSession({ sessionName, cwd, terminal, socketName: tmuxSocketName });
    } catch (error) {
      killTmuxSession(sessionName, tmuxSocketName);
      throw error;
    }
  }
  const session: WorkspaceSession = {
    id: sessionId,
    kind: "terminal",
    workspaceId: workspace.id,
    runtimeId: null,
    displayName: input.displayName || terminal.displayName,
    targetType,
    checkoutId: input.checkoutId ?? null,
    status: "running",
    statusReason: "launched",
    lastStatusAt: now,
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    terminalBackend,
    tmuxSessionName: tmux?.tmuxSessionName ?? null,
    tmuxSessionId: tmux?.tmuxSessionId ?? null,
    tmuxSocketName: tmux ? tmuxSocketName : null,
    ptySessionId: terminalBackend === "pty-daemon" ? sessionId : null,
    ptyOwnerSocket: null,
    ptyOwnerPid: null,
    ptyLastSeenAt: null,
    tabId: createId("tab"),
    runtimeSessionId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.insertWorkspaceSession(session);
  const activitySource = options.activitySource ?? "user";
  deps.activity(
    "terminal.started",
    activitySource,
    `Started ${session.displayName}`,
    workspace.repoId,
    workspace.id,
    null,
  );
  return session;
}

function configuredTerminalBackend(): WorkspaceSession["terminalBackend"] {
  return process.env.CITADEL_TERMINAL_BACKEND === "tmux" ? "tmux" : "pty-daemon";
}

async function launchRuntimeOnce(
  sessionName: string,
  socketName: string | null,
  command: string,
  args: string[],
  options: RuntimeLaunchOptions,
): Promise<number> {
  const startedAt = Date.now();
  await launchAgentInSession(sessionName, command, args, launchAgentOptions(socketName, options));
  return startedAt;
}

async function withCodexLaunchLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = codexLaunchQueue;
  let release!: () => void;
  codexLaunchQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

async function launchCodexWithRetry(
  sessionName: string,
  socketName: string | null,
  command: string,
  args: string[],
  options: RuntimeLaunchOptions,
): Promise<number> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= CODEX_LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      await launchAgentInSession(sessionName, command, args, launchAgentOptions(socketName, options));
      if (await runtimeStayedForeground(sessionName, socketName, command, CODEX_LAUNCH_STABILITY_MS)) return startedAt;

      const error = new Error(
        `codex_runtime_exited_during_startup: foreground=${panePidProcess(sessionName, socketName)?.command ?? "missing"}`,
      );
      if (!codexPaneShowsStateDbLock(sessionName, socketName) || attempt === CODEX_LAUNCH_MAX_ATTEMPTS) throw error;
      lastError = error;
    } catch (error) {
      if (!codexPaneShowsStateDbLock(sessionName, socketName) || attempt === CODEX_LAUNCH_MAX_ATTEMPTS) throw error;
      lastError = error;
    }
    await sleep(codexRetryDelayMs(attempt));
  }
  throw lastError instanceof Error ? lastError : new Error("codex_launch_failed");
}

function launchAgentOptions(
  socketName: string | null,
  options: RuntimeLaunchOptions,
): { socketName: string | null; exitHint: AgentExitHint; env?: RuntimeLaunchEnv } {
  const launchOptions: { socketName: string | null; exitHint: AgentExitHint; env?: RuntimeLaunchEnv } = {
    socketName,
    exitHint: options.exitHint,
  };
  if (options.env !== undefined) launchOptions.env = options.env;
  return launchOptions;
}

async function runtimeStayedForeground(
  sessionName: string,
  socketName: string | null,
  command: string,
  durationMs: number,
): Promise<boolean> {
  const target = command.slice(0, COMM_TRUNCATION);
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    if (panePidProcess(sessionName, socketName)?.command !== target) return false;
    await sleep(100);
  }
  return true;
}

function codexPaneShowsStateDbLock(sessionName: string, socketName: string | null): boolean {
  const transcript = captureTranscript(sessionName, { lines: 80, maxChars: 8000, socketName });
  return transcript.ok && CODEX_STATE_DB_LOCKED.test(transcript.text);
}

function codexRetryDelayMs(attempt: number): number {
  const base = Math.min(4000, 500 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSessionCwd(input: {
  workspace: Workspace;
  checkout: WorktreeCheckout | null;
  targetType: ExecutionTarget["type"];
}): string {
  if (input.checkout) return executionTargetCwd(input);
  if (input.targetType === "workspace_home") {
    return executionTargetCwd({ workspace: input.workspace, targetType: "workspace_home" });
  }
  if (input.workspace.mode === "structured") throw new Error("checkout_required");
  return input.workspace.path;
}
