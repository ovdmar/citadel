import type { AgentSession, Repo, Workspace } from "@citadel/contracts";

export type McpStatusSnapshot = {
  enabled: boolean;
  resources: string[];
  tools: string[];
};

export function mcpStatus(enabled: boolean): McpStatusSnapshot {
  return {
    enabled,
    resources: ["citadel://repos", "citadel://workspaces", "citadel://provider-health"],
    tools: ["list_repos", "list_workspaces", "create_workspace", "start_agent", "inspect_status"],
  };
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
