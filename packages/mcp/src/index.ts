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
  | "list_runtimes";

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
    tools: [
      "inspect_status",
      "list_repos",
      "list_workspaces",
      "list_agent_sessions",
      "list_provider_health",
      "list_runtimes",
    ],
  };
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
