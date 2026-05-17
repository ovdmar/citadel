import { describe, expect, it } from "vitest";
import { mcpStatus, serializeWorkspaceResource } from "./index.js";

describe("mcp helpers", () => {
  it("reports local/internal MCP tools and resources", () => {
    const status = mcpStatus(true);

    expect(status.enabled).toBe(true);
    expect(status.tools).toContain("inspect_status");
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
});
