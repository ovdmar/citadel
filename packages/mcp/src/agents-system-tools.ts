export const AGENTS_SYSTEM_TOOL_DEFINITIONS = [
  {
    name: "get_citadel_context",
    description:
      "Resolve the caller cwd to a registered workspace Home or checkout and return the scoped workspace, checkout, active plan, manager, and deviation context. cwd must be inside a Citadel-registered workspace root or checkout.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      properties: { cwd: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "list_workspace_checkouts",
    description: "List worktree checkouts for a structured workspace.",
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      properties: { workspaceId: { type: "string" } },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "create_workspace_checkout",
    description:
      "Create a repo worktree checkout under a structured workspace root. Use source=upstream_checkout for stacked work that starts from another checkout branch.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "repoId", "name", "branch"],
      properties: {
        workspaceId: { type: "string" },
        repoId: { type: "string" },
        name: { type: "string", minLength: 1 },
        branch: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        source: { type: "string", enum: ["default_branch", "existing_branch", "pr", "upstream_checkout"] },
        upstreamCheckoutId: { type: "string" },
        issue: { type: "object" },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "register_workspace_plan",
    description:
      "Register a workspace plan artifact from a local path inside the workspace root. Accepts workspaceId or cwd, computes a content hash, allocates the next version, and makes approved plans active.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        workspaceId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        path: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["draft", "under_review", "changes_requested", "approved", "superseded"] },
        approvalMode: { type: "string", enum: ["manual", "auto"] },
        createdBySessionId: { type: "string" },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "get_workspace_plan",
    description: "Return active and historical workspace plan versions plus open plan deviations for a workspace.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" }, cwd: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "report_plan_deviation",
    description:
      "Record a structured plan deviation from an implementation or manager context. Defaults to the active plan resolved from workspaceId/cwd.",
    inputSchema: {
      type: "object",
      required: ["description"],
      properties: {
        workspaceId: { type: "string" },
        checkoutId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        planVersionId: { type: "string" },
        severity: { type: "string", enum: ["info", "blocking"] },
        description: { type: "string", minLength: 1 },
        reportedBySessionId: { type: "string" },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "launch_pm_agent",
    description:
      "Launch the predefined PM role on workspace Home. Without workspaceId/cwd it bootstraps a zero-checkout structured workspace shell from idea/workspaceName/parentIssue.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        idea: { type: "string", minLength: 1 },
        workspaceName: { type: "string", minLength: 1 },
        parentIssue: { type: "object" },
        actor: { type: "string", enum: ["human", "manager", "agent", "mcp", "system"] },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "launch_architect_agent",
    description:
      "Launch the predefined Architect role on structured workspace Home after discovery is marked ready. Requires planApprovalMode.",
    inputSchema: {
      type: "object",
      required: ["planApprovalMode"],
      properties: {
        workspaceId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        planApprovalMode: { type: "string", enum: ["manual", "auto"] },
        actor: { type: "string", enum: ["human", "manager", "agent", "mcp", "system"] },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "launch_implementation_agent",
    description:
      "Launch the predefined Implementation role in a checkout. Structured launches require an approved active workspace plan, parent issue, and child issue binding.",
    inputSchema: {
      type: "object",
      properties: {
        checkoutId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        planVersionId: { type: "string" },
        actor: { type: "string", enum: ["human", "manager", "agent", "mcp", "system"] },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "launch_prototype_agent",
    description: "Launch the predefined Prototype role in a checkout. Prototypes can run before plan approval.",
    inputSchema: {
      type: "object",
      properties: {
        checkoutId: { type: "string" },
        cwd: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
        actor: { type: "string", enum: ["human", "manager", "agent", "mcp", "system"] },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
] as const;
