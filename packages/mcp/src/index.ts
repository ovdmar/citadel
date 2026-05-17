import type { AgentRuntime, AgentSession, Operation, ProviderHealth, Repo, Workspace } from "@citadel/contracts";

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
  | "create_workspace"
  | "start_agent_session"
  | "archive_workspace";

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
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
};

export type McpToolCall = {
  name: McpToolName;
  arguments?: Record<string, unknown>;
};

export function mcpStatus(enabled: boolean): McpStatusSnapshot {
  return {
    enabled,
    resources: ["citadel://repos", "citadel://workspaces", "citadel://provider-health"],
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
      description: "List agent sessions, optionally filtered by workspaceId.",
      inputSchema: { type: "object", properties: { workspaceId: { type: "string" } }, additionalProperties: false },
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
    case "list_agent_sessions":
      return {
        sessions: filterByWorkspace(context.sessions, call.arguments?.workspaceId),
      };
    case "list_provider_health":
      return { providerHealth: context.providerHealth };
    case "list_runtimes":
      return { runtimes: context.runtimes };
    case "create_workspace":
    case "start_agent_session":
    case "archive_workspace":
      return { error: "mutating_tool_requires_daemon" };
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

function filterByRepo(workspaces: Workspace[], repoId: unknown) {
  return typeof repoId === "string" ? workspaces.filter((workspace) => workspace.repoId === repoId) : workspaces;
}

function filterByWorkspace(sessions: AgentSession[], workspaceId: unknown) {
  return typeof workspaceId === "string" ? sessions.filter((session) => session.workspaceId === workspaceId) : sessions;
}

function assertNever(value: never): never {
  throw new Error(`Unknown MCP tool: ${String(value)}`);
}
