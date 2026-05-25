import type {
  ActivityEvent,
  AgentRuntime,
  AgentSession,
  HookAction,
  HookLink,
  Operation,
  ProviderHealth,
  Repo,
  Workspace,
} from "@citadel/contracts";

export type AgentSessionSummary = AgentSession & {
  initialPrompt: string | null;
  messageCount: number;
};

export type McpStatusSnapshot = {
  enabled: boolean;
  resources: string[];
  tools: string[];
};

export type McpToolName =
  | "inspect_status"
  | "list_repos"
  | "list_workspaces"
  | "list_agent_sessions"
  | "list_provider_health"
  | "list_runtimes"
  | "list_workspace_links"
  | "register_repo"
  | "create_workspace"
  | "start_agent_session"
  | "launch_agent"
  | "stop_agent_session"
  | "archive_workspace"
  | "remove_workspace"
  | "reconcile"
  | "inspect_readiness"
  | "read_agent_output"
  | "send_agent_message"
  | "read_scratchpad"
  | "write_scratchpad"
  | "append_scratchpad"
  | "list_deployed_apps"
  | "redeploy_app"
  | "read_agent_history";

export type McpToolDefinition = {
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
};

export type McpToolContext = {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activity: ActivityEvent[];
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  sessionPromptSummary?: (sessionId: string) => { initialPrompt: string | null; messageCount: number };
};

const INITIAL_PROMPT_PREVIEW_CHARS = 200;

export type McpToolCall = {
  name: McpToolName;
  arguments?: Record<string, unknown>;
};

export function mcpStatus(enabled: boolean): McpStatusSnapshot {
  return {
    enabled,
    resources: ["citadel://repos", "citadel://workspaces", "citadel://provider-health", "citadel://activity"],
    tools: mcpToolDefinitions().map((tool) => tool.name),
  };
}

export function mcpToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "inspect_status",
      description: "Summarize Citadel local state and provider health.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_repos",
      description: "List registered repositories.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_workspaces",
      description: "List workspaces, optionally filtered by repoId.",
      inputSchema: { type: "object", properties: { repoId: { type: "string" } }, additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_agent_sessions",
      description:
        "List agent sessions with status, runtime, and tmux session metadata. Each entry includes a truncated initialPrompt and a messageCount so callers can see what the agent was asked to do and how much follow-up steering it has received. Use read_agent_history for the full text. Optionally filter by workspaceId.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" } }, additionalProperties: false },
      destructive: false,
    },
    {
      name: "read_agent_output",
      description:
        "Read the latest terminal output (transcript) of a specific agent session. Bounded by lines and maxChars to avoid unbounded scrollback. Returns plain text captured from the backing tmux pane.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          lines: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
          maxChars: { type: "integer", minimum: 256, maximum: 200000, default: 16000 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "read_agent_history",
      description:
        "Read the ordered list of user-authored prompts sent to an agent session: the initial prompt that started it plus every follow-up sent via send_agent_message. For Claude Code sessions, the .jsonl transcript is parsed on demand and merged in so messages typed directly in the terminal are included. Limit and maxChars cap the returned slice; older messages are dropped first.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 2000, default: 200 },
          maxChars: { type: "integer", minimum: 256, maximum: 1000000, default: 64000 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "send_agent_message",
      description:
        "Send a follow-up message/prompt to an existing agent session. Targets the session id and submits the text into the backing tmux pane (paste + Enter), so it works for Claude Code and other interactive runtimes. Returns an error if the session has no terminal or is not accepting input.",
      inputSchema: {
        type: "object",
        required: ["sessionId", "message"],
        properties: {
          sessionId: { type: "string" },
          message: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_provider_health",
      description: "List normalized provider health snapshots.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_runtimes",
      description: "List configured agent runtimes and their health.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "list_workspace_links",
      description: "List hook-provided workspace links and actions, optionally filtered by workspaceId.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" } }, additionalProperties: false },
      destructive: false,
    },
    {
      name: "register_repo",
      description:
        "Register an existing local git repository with Citadel so it appears in list_repos and can host workspaces. Provide the absolute rootPath of a directory containing a .git folder. Optionally override the display name and worktreeParent (defaults to <repo>-worktrees next to the repo). Also creates the non-removable root workspace pointing at the repo working copy. Returns { repo }.",
      inputSchema: {
        type: "object",
        required: ["rootPath"],
        properties: {
          rootPath: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          worktreeParent: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "create_workspace",
      description: "Create a workspace through the daemon operation service.",
      inputSchema: {
        type: "object",
        required: ["repoId", "name"],
        properties: {
          repoId: { type: "string" },
          name: { type: "string" },
          source: { type: "string" },
          issueKey: { type: "string" },
          issueTitle: { type: "string" },
          prUrl: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "start_agent_session",
      description: "Start a configured agent runtime in a workspace through the daemon operation service.",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "runtimeId"],
        properties: {
          workspaceId: { type: "string" },
          runtimeId: { type: "string" },
          displayName: { type: "string" },
          prompt: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "launch_agent",
      description:
        "High-level one-shot: create a fresh scratch workspace in a repo and immediately start an agent session in it with the given prompt. Returns { workspaceId, sessionId, branchName, workspacePath, operationId }. Use this instead of chaining create_workspace + start_agent_session when an orchestrator just wants 'run this prompt in repo X'. Pass exactly one of repoId or repoName; runtimeId defaults to claude-code. namespaceId is accepted but currently ignored (namespaces not yet implemented).",
      inputSchema: {
        type: "object",
        required: ["prompt"],
        properties: {
          repoId: { type: "string", description: "Internal repo id (provide this OR repoName)." },
          repoName: { type: "string", description: "Configured repo display name (provide this OR repoId)." },
          prompt: { type: "string", minLength: 1 },
          runtimeId: { type: "string", default: "claude-code" },
          displayName: { type: "string", maxLength: 80 },
          workspaceName: { type: "string", maxLength: 80 },
          namespaceId: { type: "string", maxLength: 80 },
          branchName: { type: "string", maxLength: 120 },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "archive_workspace",
      description: "Archive workspace metadata without deleting the worktree.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "stop_agent_session",
      description: "Stop a running agent session via the operation service.",
      inputSchema: {
        type: "object",
        required: ["sessionId"],
        properties: { sessionId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "remove_workspace",
      description:
        "Remove a workspace through the operation service. Set archiveOnly to keep the worktree, force to override dirty/teardown protection.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          archiveOnly: { type: "boolean" },
          force: { type: "boolean" },
        },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "reconcile",
      description: "Reconcile local state with reality: cleanup orphan sessions, ghost repos, and missing worktrees.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: true,
    },
    {
      name: "read_scratchpad",
      description:
        "Read the user's scratchpad. The user notes thoughts and TODOs here for orchestrator agents to pick up. Returns { content, updatedAt }.",
      inputSchema: { type: "object", additionalProperties: false },
      destructive: false,
    },
    {
      name: "write_scratchpad",
      description:
        "Overwrite the scratchpad. Replaces all existing content. Returns the new { content, updatedAt }. Prefer append_scratchpad to add notes without clobbering.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: { content: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "append_scratchpad",
      description:
        "Append to the scratchpad without losing existing content. Inserts a blank-line separator before the new chunk. Returns { content, updatedAt }.",
      inputSchema: {
        type: "object",
        required: ["content"],
        properties: { content: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "list_deployed_apps",
      description:
        "List the deployed apps for a workspace by invoking its deploy hook (`<hook> list`) and probing each app's URL for reachability. Resolves the hook in this order: `<workspacePath>/.citadel/hooks/deploy` (if executable) > the repo's deployHookCommand. Returns { workspaceId, resolution: { source, filePath?, command? }, apps: [{ name, url, status: 'deployed'|'stopped'|'unknown', lastChecked }], error?, checkedAt }. `source` is 'none' when no deploy hook is configured.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "redeploy_app",
      description:
        "Invoke the workspace's deploy hook with `redeploy [name]`. Omitting `name` redeploys all apps. The hook runs with cwd = workspace path and env CITADEL_WORKSPACE_ID/CITADEL_WORKSPACE_PATH/CITADEL_WORKSPACE_BRANCH/CITADEL_REPO_ID set. Returns { operationId, status, exitStatus } — stream the operation log via /api/operations/:id for live output.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          name: {
            type: "string",
            maxLength: 80,
            description: "App name from list_deployed_apps. Omit to redeploy all.",
          },
        },
        additionalProperties: false,
      },
      destructive: true,
    },
    {
      name: "inspect_readiness",
      description: "Return the readiness state and next-action hint for a workspace.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: { workspaceId: { type: "string" } },
        additionalProperties: false,
      },
      destructive: false,
    },
  ];
}

export function callMcpTool(call: McpToolCall, context: McpToolContext) {
  switch (call.name) {
    case "inspect_status":
      return {
        repos: context.repos.length,
        workspaces: context.workspaces.length,
        sessions: context.sessions.length,
        operations: context.operations.slice(0, 10),
        providerHealth: context.providerHealth,
      };
    case "list_repos":
      return { repos: context.repos };
    case "list_workspaces":
      return {
        workspaces: filterByRepo(context.workspaces, call.arguments?.repoId),
      };
    case "list_agent_sessions": {
      const filtered = filterByWorkspace(context.sessions, call.arguments?.workspaceId);
      const summarize = context.sessionPromptSummary;
      const sessions: AgentSessionSummary[] = filtered.map((session) => {
        const summary = summarize?.(session.id) ?? { initialPrompt: null, messageCount: 0 };
        return {
          ...session,
          initialPrompt: truncatePrompt(summary.initialPrompt),
          messageCount: summary.messageCount,
        };
      });
      return { sessions };
    }
    case "list_provider_health":
      return { providerHealth: context.providerHealth };
    case "list_runtimes":
      return { runtimes: context.runtimes };
    case "list_workspace_links":
      return listWorkspaceLinks(context.activity, call.arguments?.workspaceId);
    case "inspect_readiness": {
      const workspaceId = typeof call.arguments?.workspaceId === "string" ? (call.arguments.workspaceId as string) : "";
      const workspace = context.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) return { error: "workspace_not_found", workspaceId };
      return {
        workspaceId,
        lifecycle: workspace.lifecycle,
        sessions: context.sessions
          .filter((session) => session.workspaceId === workspaceId)
          .map((session) => ({ id: session.id, status: session.status, runtimeId: session.runtimeId })),
        operations: context.operations.filter((operation) => operation.workspaceId === workspaceId).slice(0, 5),
      };
    }
    case "register_repo":
    case "create_workspace":
    case "start_agent_session":
    case "launch_agent":
    case "stop_agent_session":
    case "archive_workspace":
    case "remove_workspace":
    case "reconcile":
    case "write_scratchpad":
    case "append_scratchpad":
    case "list_deployed_apps":
    case "redeploy_app":
      return { error: "mutating_tool_requires_daemon" };
    case "read_agent_output":
    case "send_agent_message":
    case "read_agent_history":
      // These read or write the live tmux pane backing an agent session, so
      // they cannot run from the in-memory snapshot — only the daemon owns the
      // tmux/terminal manager. Return a stable sentinel so MCP transports can
      // route these to the daemon path explicitly.
      return { error: "session_tool_requires_daemon" };
    case "read_scratchpad":
      // The scratchpad lives on disk under the daemon's data dir; the snapshot
      // path has no fs access, so route through the daemon explicitly.
      return { error: "scratchpad_tool_requires_daemon" };
    default:
      return assertNever(call.name);
  }
}

export function serializeWorkspaceResource(input: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
}) {
  return {
    repos: input.repos,
    workspaces: input.workspaces,
    sessions: input.sessions.map((session) => ({
      id: session.id,
      workspaceId: session.workspaceId,
      runtimeId: session.runtimeId,
      status: session.status,
      tmuxSessionName: session.tmuxSessionName,
    })),
  };
}

export function listWorkspaceLinks(activity: ActivityEvent[], workspaceId: unknown) {
  const events =
    typeof workspaceId === "string" ? activity.filter((event) => event.workspaceId === workspaceId) : activity;
  const links: Array<HookLink & { workspaceId: string; eventId: string }> = [];
  const actions: Array<HookAction & { workspaceId: string; eventId: string }> = [];
  for (const event of events) {
    if (!event.workspaceId || !event.hookOutput) continue;
    links.push(
      ...event.hookOutput.links.map((link) => ({ ...link, workspaceId: event.workspaceId ?? "", eventId: event.id })),
    );
    actions.push(
      ...event.hookOutput.actions.map((action) => ({
        ...action,
        workspaceId: event.workspaceId ?? "",
        eventId: event.id,
      })),
    );
  }
  return { links, actions };
}

function truncatePrompt(text: string | null) {
  if (!text) return null;
  if (text.length <= INITIAL_PROMPT_PREVIEW_CHARS) return text;
  return `${text.slice(0, INITIAL_PROMPT_PREVIEW_CHARS)}…`;
}

function filterByRepo(workspaces: Workspace[], repoId: unknown) {
  return typeof repoId === "string" ? workspaces.filter((workspace) => workspace.repoId === repoId) : workspaces;
}

function filterByWorkspace(sessions: AgentSession[], workspaceId: unknown) {
  return typeof workspaceId === "string" ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions;
}

function assertNever(value: never): never {
  throw new Error(`Unknown MCP tool: ${String(value)}`);
}
