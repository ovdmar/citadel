// Tool definitions for the agents-system MCP surface. Kept in a sibling file
// so packages/mcp/src/index.ts stays under the 800-line file-size budget.

export type AgentLauncherToolName =
  | "launch_implementation_agent"
  | "launch_prototype_agent"
  | "launch_pm_agent"
  | "launch_architect_agent"
  | "list_custom_agents"
  | "launch_custom_agent"
  | "register_plan"
  | "launch_handoff_agent";

export type AgentLauncherToolDefinition = {
  name: AgentLauncherToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  destructive: boolean;
};

function predefinedLaunchInputSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1 },
      workspaceId: { type: "string", description: "Reuse an existing workspace. Omit to create a new one." },
      repoId: { type: "string" },
      repoName: { type: "string" },
      namespaceId: { type: "string" },
      displayName: { type: "string" },
      workspaceName: { type: "string" },
      branchName: { type: "string" },
    },
    additionalProperties: false,
  };
}

export function agentLauncherToolDefinitions(): AgentLauncherToolDefinition[] {
  const predefined = (kind: "implementation" | "prototype" | "pm" | "architect"): AgentLauncherToolDefinition => ({
    name: `launch_${kind}_agent`,
    description: `Launch the predefined "${kind}" agent (system prompt + runtime + model from ~/.citadel/agents/${kind}.json). The agent's system prompt is prepended to the supplied prompt; the launch otherwise behaves like launch_agent. Provide workspaceId to reuse an existing workspace, or omit to create a new one.`,
    inputSchema: predefinedLaunchInputSchema(),
    destructive: false,
  });
  return [
    predefined("implementation"),
    predefined("prototype"),
    predefined("pm"),
    predefined("architect"),
    {
      name: "list_custom_agents",
      description:
        "Return the user-defined custom agent definitions (kind === 'custom'). Predefined agents (implementation, prototype, pm, architect) are returned by their dedicated launchers.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      destructive: false,
    },
    {
      name: "launch_custom_agent",
      description:
        "Launch a user-defined custom agent by id. The agent's system prompt is prepended to the supplied prompt. Provide workspaceId to reuse, omit to create.",
      inputSchema: {
        type: "object",
        required: ["prompt", "agentId"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          agentId: { type: "string" },
          workspaceId: { type: "string" },
          repoId: { type: "string" },
          repoName: { type: "string" },
          namespaceId: { type: "string" },
          displayName: { type: "string" },
          workspaceName: { type: "string" },
          branchName: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "register_plan",
      description:
        "Register a plan file inside a workspace for later handoff. Path is validated via fs.realpath to reject symlink escapes; only regular files ≤1 MiB inside <workspacePath> are accepted. Returns { planId, registeredAt }.",
      inputSchema: {
        type: "object",
        required: ["workspaceId", "path"],
        properties: {
          workspaceId: { type: "string" },
          path: { type: "string" },
          summary: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
    {
      name: "launch_handoff_agent",
      description:
        "Launch a named agent in an existing workspace, primed with a registered plan. Plan resolution order: planId → newest registered plan for the workspace → newest <workspacePath>/.agents/plans/*.md → no_plan_found. Provide exactly one of predefinedKind (implementation|prototype|pm|architect) or customAgentId.",
      inputSchema: {
        type: "object",
        required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string" },
          planId: { type: "string" },
          predefinedKind: { type: "string", enum: ["implementation", "prototype", "pm", "architect"] },
          customAgentId: { type: "string" },
          additionalPrompt: { type: "string" },
        },
        additionalProperties: false,
      },
      destructive: false,
    },
  ];
}
