import { describe, expect, it } from "vitest";
import type { McpToolContext } from "./index.js";
import { callMcpTool, mcpStatus, mcpToolDefinitions, serializeWorkspaceResource } from "./index.js";

describe("mcp helpers", () => {
  it("reports local/internal MCP tools and resources", () => {
    const status = mcpStatus(true);

    expect(status.enabled).toBe(true);
    expect(status.tools).toContain("inspect_status");
    expect(status.tools).toContain("start_agent_session");
    expect(status.tools).toContain("list_workspace_links");
    expect(status.tools).toContain("read_agent_output");
    expect(status.tools).toContain("send_agent_message");
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
  });

  it("serializes normalized workspace resources without raw terminal transport", () => {
    const resource = serializeWorkspaceResource({
      repos: [],
      workspaces: [],
      sessions: [
        {
          id: "sess_test",
          workspaceId: "ws_test",
          runtimeId: "shell",
          displayName: "Shell",
          status: "running",
          transport: "connected",
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
      runtimeId: "shell",
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
          prUrl: null,
          issueKey: null,
          issueTitle: null,
          issueUrl: null,
          slackThreadUrl: null,
          section: "backlog",
          pinned: false,
          lifecycle: "ready",
          dirty: false,
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      sessions: [
        {
          id: "sess_test",
          workspaceId: "ws_test",
          runtimeId: "shell",
          displayName: "Shell",
          status: "running",
          transport: "connected",
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
          id: "shell",
          displayName: "Shell",
          command: "bash",
          args: ["-l"],
          health: "healthy",
          healthReason: null,
          capabilities: {
            supportsPrompt: false,
            supportsResume: false,
            supportsModelSelection: false,
            supportsTranscript: false,
            supportsStatusDetection: false,
            supportsNonInteractiveGoal: false,
            supportsShell: true,
            supportsUsage: false,
          },
        },
      ],
    } satisfies McpToolContext;

    const result = callMcpTool({ name: "inspect_status" }, context);
    expect(result).toMatchObject({ repos: 1, workspaces: 1, sessions: 1 });
    expect(callMcpTool({ name: "list_repos" }, context)).toEqual({ repos: context.repos });
    expect(callMcpTool({ name: "list_workspaces", arguments: { repoId: "repo_test" } }, context)).toEqual({
      workspaces: context.workspaces,
    });
    expect(callMcpTool({ name: "list_agent_sessions", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      sessions: context.sessions,
    });
    expect(callMcpTool({ name: "list_provider_health" }, context)).toEqual({
      providerHealth: context.providerHealth,
    });
    expect(callMcpTool({ name: "list_runtimes" }, context)).toEqual({ runtimes: context.runtimes });
    expect(callMcpTool({ name: "list_workspace_links", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      links: [expect.objectContaining({ label: "Preview", workspaceId: "ws_test" })],
      actions: [expect.objectContaining({ id: "redeploy", workspaceId: "ws_test" })],
    });
    expect(callMcpTool({ name: "archive_workspace", arguments: { workspaceId: "ws_test" } }, context)).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(
      callMcpTool({ name: "start_agent_session", arguments: { workspaceId: "ws_test", runtimeId: "shell" } }, context),
    ).toEqual({
      error: "mutating_tool_requires_daemon",
    });
    expect(callMcpTool({ name: "read_agent_output", arguments: { sessionId: "sess_test" } }, context)).toEqual({
      error: "session_tool_requires_daemon",
    });
    expect(
      callMcpTool({ name: "send_agent_message", arguments: { sessionId: "sess_test", message: "hi" } }, context),
    ).toEqual({
      error: "session_tool_requires_daemon",
    });
  });
});
