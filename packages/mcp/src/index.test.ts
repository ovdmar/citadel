import { describe, expect, it } from "vitest";
import type { McpToolContext } from "./index.js";
import { callMcpTool, mcpStatus, mcpToolDefinitions, serializeWorkspaceResource } from "./index.js";

describe("mcp helpers", () => {
  it("reports local/internal MCP tools and resources", () => {
    const status = mcpStatus(true);

    expect(status.enabled).toBe(true);
    expect(status.tools).toContain("inspect_status");
    expect(status.tools).toContain("start_agent_session");
    expect(status.tools).toContain("launch_agent");
    expect(status.tools).toContain("list_scheduled_agents");
    expect(status.tools).toContain("create_scheduled_agent");
    expect(status.tools).toContain("update_scheduled_agent");
    expect(status.tools).toContain("delete_scheduled_agent");
    expect(status.tools).toContain("run_scheduled_agent_now");
    const createScheduled = mcpToolDefinitions().find((tool) => tool.name === "create_scheduled_agent");
    expect(createScheduled?.inputSchema).toMatchObject({
      required: ["name", "repoId", "runtimeId", "workspaceStrategy", "workspaceName"],
    });
    expect(mcpToolDefinitions().find((tool) => tool.name === "delete_scheduled_agent")?.destructive).toBe(true);
    expect(status.tools).toContain("list_workspace_links");
    expect(status.tools).toContain("read_agent_output");
    expect(status.tools).toContain("send_agent_message");
    expect(status.tools).toContain("undeploy_app");
    for (const name of [
      "get_citadel_context",
      "list_workspace_checkouts",
      "create_workspace_checkout",
      "register_workspace_plan",
      "get_workspace_plan",
      "report_plan_deviation",
      "start_workspace_manager",
      "pause_workspace_manager",
      "resume_workspace_manager",
      "mark_checkout_ready_for_review",
      "get_checkout_ticket",
      "get_checkout_pr",
      "get_checkout_gate_status",
      "list_review_threads",
      "create_review_thread",
      "reply_review_thread",
      "resolve_review_thread",
      "reopen_review_thread",
      "update_ticket_status",
      "launch_pm_agent",
      "launch_architect_agent",
      "launch_implementation_agent",
      "launch_prototype_agent",
    ]) {
      expect(status.tools).toContain(name);
    }
    const launch = mcpToolDefinitions().find((tool) => tool.name === "launch_agent");
    expect(launch).toBeDefined();
    expect(launch?.destructive).toBe(false);
    expect(launch?.inputSchema).toMatchObject({ required: ["prompt"] });
    expect(status.resources).toContain("citadel://activity");
    expect(mcpToolDefinitions().find((tool) => tool.name === "archive_workspace")).toMatchObject({
      destructive: false,
    });
    const sendMessage = mcpToolDefinitions().find((tool) => tool.name === "send_agent_message");
    expect(sendMessage).toBeDefined();
    expect(sendMessage?.destructive).toBe(false);
    expect(sendMessage?.inputSchema).toMatchObject({ required: ["sessionId", "message"] });
    expect(mcpToolDefinitions().find((tool) => tool.name === "read_agent_output")?.inputSchema).toMatchObject({
      required: ["sessionId"],
    });

    // Scratchpad block tools live in scratchpad-tools.ts and are spread into the registry.
    for (const name of [
      "read_scratchpad",
      "write_scratchpad",
      "append_scratchpad",
      "list_blocks",
      "add_block",
      "update_block",
      "delete_block",
    ]) {
      expect(status.tools).toContain(name);
    }
    expect(mcpToolDefinitions().find((tool) => tool.name === "delete_block")?.destructive).toBe(true);
    const appendDef = mcpToolDefinitions().find((tool) => tool.name === "append_scratchpad");
    // The append description now states one-call-one-block semantics rather than "blank-line separator".
    expect(appendDef?.description).toMatch(/new block/);
    expect(appendDef?.description).not.toMatch(/blank-line/);
    const addBlockDef = mcpToolDefinitions().find((tool) => tool.name === "add_block");
    expect(addBlockDef?.inputSchema).toMatchObject({ required: ["text"] });

    // Configurable-notes location surface: clients learn about `path` through
    // these descriptions, so an absent reference would silently downgrade
    // discoverability.
    const inspectDef = mcpToolDefinitions().find((tool) => tool.name === "inspect_status");
    expect(inspectDef?.description).toMatch(/scratchpad\.path/);
    const readDef = mcpToolDefinitions().find((tool) => tool.name === "read_scratchpad");
    expect(readDef?.description).toMatch(/\bpath\b/);
    expect(readDef?.description).toMatch(/scratchpad\.path|configurable|dataDir\/scratchpad\.md/);
  });

  it("inspect_status surfaces scratchpad.path from McpToolContext", () => {
    const customPath = "/Users/op/Documents/citadel-notes.md";
    const context: McpToolContext = {
      repos: [],
      workspaces: [],
      sessions: [],
      operations: [],
      activity: [],
      providerHealth: [],
      runtimes: [],
      namespaces: [],
      scheduledAgents: [],
      scratchpadPath: customPath,
    };
    const result = callMcpTool({ name: "inspect_status" }, context) as { scratchpad: { path: string } };
    expect(result.scratchpad).toEqual({ path: customPath });
  });

  it("snapshot dispatcher routes block tools to the daemon", () => {
    const context: McpToolContext = {
      repos: [],
      workspaces: [],
      sessions: [],
      operations: [],
      activity: [],
      providerHealth: [],
      runtimes: [],
      namespaces: [],
      scheduledAgents: [],
      scratchpadPath: "/tmp/test-scratchpad.md",
    };
    for (const name of ["read_scratchpad", "list_blocks", "add_block", "update_block", "delete_block"] as const) {
      expect(callMcpTool({ name }, context)).toEqual({ error: "scratchpad_tool_requires_daemon" });
    }
    expect(callMcpTool({ name: "create_review_thread", arguments: {} }, context)).toEqual({
      error: "review_tool_requires_daemon",
    });
  });

  it("serializes normalized workspace resources without raw terminal transport", () => {
    const resource = serializeWorkspaceResource({
      repos: [],
      workspaces: [],
      sessions: [
        {
          id: "sess_test",
          workspaceId: "ws_test",
          kind: "agent",
          runtimeId: "codex",
          displayName: "Codex",
          status: "running",
          transport: "connected",
          terminalBackend: "tmux",
          tmuxSessionName: "citadel_test",
          tmuxSessionId: "$1",
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
    });

    expect(resource.sessions[0]).toEqual({
      id: "sess_test",
      workspaceId: "ws_test",
      runtimeId: "codex",
      status: "running",
      tmuxSessionName: "citadel_test",
    });
  });

  it("executes normalized local/internal tool calls", () => {
    const context = {
      repos: [
        {
          id: "repo_test",
          name: "Repo",
          rootPath: "/tmp/repo",
          defaultBranch: "main",
          defaultRemote: "origin",
          worktreeParent: "/tmp/worktrees",
          setupHookIds: [],
          teardownHookIds: [],
          providerIds: [],
          deployHookCommand: null,
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspaces: [
        {
          id: "ws_test",
          repoId: "repo_test",
          name: "Workspace",
          path: "/tmp/worktrees/workspace",
          branch: "workspace",
          baseBranch: "main",
          source: "scratch",
          kind: "worktree",
          prUrl: null,
          issueKey: null,
          issueTitle: null,
          issueUrl: null,
          slackThreadUrl: null,
          section: "backlog",
          pinned: false,
          lifecycle: "ready",
          dirty: false,
          namespaceId: null,
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      sessions: [
        {
          id: "sess_test",
          workspaceId: "ws_test",
          kind: "agent",
          runtimeId: "codex",
          displayName: "Codex",
          status: "running",
          transport: "connected",
          terminalBackend: "tmux",
          tmuxSessionName: "citadel_test",
          tmuxSessionId: "$1",
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
      operations: [
        {
          id: "op_test",
          type: "workspace.create",
          status: "succeeded",
          repoId: "repo_test",
          workspaceId: "ws_test",
          progress: 100,
          message: null,
          error: null,
          logs: [],
          retriable: false,
          retryInput: null,
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
      activity: [
        {
          id: "evt_links",
          type: "hook.workspace.created",
          source: "hook",
          repoId: "repo_test",
          workspaceId: "ws_test",
          operationId: "op_test",
          message: "Hook workspace-links completed",
          hookOutput: {
            links: [{ label: "Preview", url: "https://example.test/preview", kind: "preview" }],
            actions: [{ id: "redeploy", label: "Redeploy", description: null, url: "https://example.test/deploy" }],
            metadata: {},
          },
          createdAt: "2026-05-17T00:00:00.000Z",
        },
      ],
      providerHealth: [
        {
          id: "github-gh",
          displayName: "GitHub CLI",
          kind: "version-control",
          status: "healthy",
          reason: null,
          checkedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
      runtimes: [
        {
          id: "codex",
          displayName: "Codex",
          command: "codex",
          args: [],
          health: "healthy",
          healthReason: null,
          capabilities: {
            supportsPrompt: true,
            supportsResume: true,
            supportsModelSelection: false,
            supportsTranscript: false,
            supportsStatusDetection: true,
            supportsNonInteractiveGoal: true,
            supportsShell: true,
            supportsUsage: false,
            supportsTui: true,
          },
        },
      ],
      namespaces: [],
      scratchpadPath: "/var/data/citadel/scratchpad.md",
    } satisfies McpToolContext;

    const result = callMcpTool({ name: "inspect_status" }, context);
    expect(result).toMatchObject({
      repos: 1,
      workspaces: 1,
      sessions: 1,
      scratchpad: { path: "/var/data/citadel/scratchpad.md" },
    });
    expect(callMcpTool({ name: "list_repos" }, context)).toEqual({ repos: context.repos });
    expect(callMcpTool({ name: "list_workspaces", arguments: { repoId: "repo_test" } }, context)).toEqual({
      workspaces: context.workspaces.map((workspace) => ({ ...workspace, namespaceName: null })),
    });
    expect(callMcpTool({ name: "list_agent_sessions", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      sessions: context.sessions.map((session) => ({
        ...session,
        namespaceId: null,
        namespaceName: null,
        initialPrompt: null,
        messageCount: 0,
      })),
    });
    expect(callMcpTool({ name: "list_provider_health" }, context)).toEqual({
      providerHealth: context.providerHealth,
    });
    expect(callMcpTool({ name: "list_agent_runtimes" }, context)).toEqual({ runtimes: context.runtimes });
    expect(callMcpTool({ name: "list_runtimes" }, context)).toEqual({ runtimes: context.runtimes });
    expect(callMcpTool({ name: "list_scheduled_agents" }, context)).toEqual({ scheduledAgents: [] });
    expect(callMcpTool({ name: "create_scheduled_agent" }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "delete_scheduled_agent", arguments: { id: "sched_x" } }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "run_scheduled_agent_now", arguments: { id: "sched_x" } }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "list_workspace_links", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      links: [expect.objectContaining({ label: "Preview", workspaceId: "ws_test" })],
      actions: [expect.objectContaining({ id: "redeploy", workspaceId: "ws_test" })],
    });
    expect(callMcpTool({ name: "archive_workspace", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(
      callMcpTool({ name: "start_agent_session", arguments: { workspaceId: "ws_test", runtimeId: "codex" } }, context),
    ).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "launch_pm_agent", arguments: { idea: "Build it" } }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "read_agent_output", arguments: { sessionId: "sess_test" } }, context)).toEqual({
      error: "session_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "get_citadel_context", arguments: { cwd: "/tmp" } }, context)).toEqual({
      error: "context_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "get_checkout_gate_status", arguments: { checkoutId: "co_api" } }, context)).toEqual({
      error: "context_tool_requires_daemon",
    });
    expect(
      callMcpTool({ name: "send_agent_message", arguments: { sessionId: "sess_test", message: "hi" } }, context),
    ).toEqual({
      error: "session_tool_requires_daemon",
    });
  });

  it("can read checkouts and workspace plans from a rich snapshot", () => {
    const context: McpToolContext = {
      repos: [],
      workspaces: [],
      sessions: [],
      operations: [],
      activity: [],
      providerHealth: [],
      runtimes: [],
      namespaces: [],
      scratchpadPath: "/tmp/scratchpad.md",
      checkouts: [
        {
          id: "co_api",
          workspaceId: "ws_plan",
          repoId: "repo_api",
          name: "api",
          path: "/tmp/workspace/api",
          branch: "feature/api",
          baseBranch: "main",
          issue: null,
          intendedPr: null,
          stackParentCheckoutId: null,
          inferredPurpose: "implementation",
          gateStatus: "not_started",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      workspacePlanVersions: [
        {
          id: "plan_1",
          workspaceId: "ws_plan",
          version: 1,
          status: "approved",
          path: "/tmp/workspace/plan.md",
          hash: "hash",
          active: true,
          approvalMode: "manual",
          createdBySessionId: null,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
    };

    expect(callMcpTool({ name: "list_workspace_checkouts", arguments: { workspaceId: "ws_plan" } }, context)).toEqual({
      checkouts: [expect.objectContaining({ id: "co_api" })],
    });
    expect(callMcpTool({ name: "get_workspace_plan", arguments: { workspaceId: "ws_plan" } }, context)).toEqual({
      workspaceId: "ws_plan",
      activePlan: expect.objectContaining({ id: "plan_1" }),
      planVersions: [expect.objectContaining({ id: "plan_1" })],
    });
  });
});
