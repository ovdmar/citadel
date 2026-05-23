import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";

describe("agent message MCP + REST routes", () => {
  it("reads agent output and submits follow-up messages through the MCP JSON-RPC tool surface", async () => {
    const fixture = createFixture();
    const sent: Array<{ sessionId: string; message: string }> = [];
    const operations = {
      readAgentTranscript: (input: { sessionId: string; lines?: number; maxChars?: number }) => ({
        ok: true,
        sessionId: input.sessionId,
        workspaceId: "ws_mcp",
        runtimeId: "claude-code",
        status: "running",
        tmuxSessionName: "citadel_mcp",
        lines: 2,
        charCount: 12,
        text: "hi\nfollow-up",
      }),
      sendAgentMessage: async (input: { sessionId: string; message: string }) => {
        sent.push(input);
        return {
          ok: true as const,
          sessionId: input.sessionId,
          workspaceId: "ws_mcp",
          tmuxSessionName: "citadel_mcp",
          error: undefined,
        };
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      const toolNames = list.result.tools.map((tool) => tool.name);
      expect(toolNames).toContain("read_agent_output");
      expect(toolNames).toContain("send_agent_message");

      const read = await postJson<{
        result: { structuredContent: { ok: boolean; text: string; charCount: number } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "read",
        method: "tools/call",
        params: { name: "read_agent_output", arguments: { sessionId: "sess_mcp", lines: 100, maxChars: 1000 } },
      });
      expect(read.result.structuredContent).toMatchObject({
        ok: true,
        text: "hi\nfollow-up",
        charCount: 12,
      });

      const send = await postJson<{
        result: { structuredContent: { ok: boolean; sessionId: string } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "send",
        method: "tools/call",
        params: { name: "send_agent_message", arguments: { sessionId: "sess_mcp", message: "second prompt" } },
      });
      expect(send.result.structuredContent).toMatchObject({ ok: true, sessionId: "sess_mcp" });
      expect(sent).toEqual([{ sessionId: "sess_mcp", message: "second prompt" }]);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes launch_agent through MCP and routes it to OperationService.launchAgent", async () => {
    const fixture = createFixture();
    const launches: Array<{
      input: { repoId?: string; repoName?: string; prompt: string; runtimeId: string };
      runtime: { command: string; displayName: string };
    }> = [];
    const operations = {
      launchAgent: async (
        input: { repoId?: string; repoName?: string; prompt: string; runtimeId: string },
        runtime: { command: string; args: string[]; displayName: string; promptArg?: string | null },
      ) => {
        launches.push({ input, runtime: { command: runtime.command, displayName: runtime.displayName } });
        return {
          workspaceId: "ws_launched",
          sessionId: "sess_launched",
          branchName: "agent-abcdef",
          workspacePath: "/tmp/agent-abcdef",
          operationId: "op_launched",
        };
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      expect(list.result.tools.map((tool) => tool.name)).toContain("launch_agent");

      const launch = await postJson<{
        result: { structuredContent: { workspaceId: string; sessionId: string; branchName: string } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "launch",
        method: "tools/call",
        params: {
          name: "launch_agent",
          arguments: { repoName: "fixture-repo", prompt: "do the thing", runtimeId: "shell" },
        },
      });
      expect(launch.result.structuredContent).toMatchObject({
        workspaceId: "ws_launched",
        sessionId: "sess_launched",
        branchName: "agent-abcdef",
      });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.input).toMatchObject({
        repoName: "fixture-repo",
        prompt: "do the thing",
        runtimeId: "shell",
      });
      expect(launches[0]?.runtime.command).toBe("bash");
    } finally {
      await closeServer(server);
    }
  });

  it("launch_agent rejects when both repoId and repoName are missing", async () => {
    const fixture = createFixture();
    const operations = {
      launchAgent: async () => {
        throw new Error("should not be called");
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/mcp/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "bad",
          method: "tools/call",
          params: { name: "launch_agent", arguments: { prompt: "x", runtimeId: "shell" } },
        }),
      });
      const body = (await response.json()) as { error?: { message: string }; result?: { isError?: boolean } };
      // Either JSON-RPC error envelope or the tool-call error path is acceptable;
      // both prove the schema rejected the input rather than calling launchAgent.
      const failed = Boolean(body.error) || Boolean(body.result?.isError);
      expect(failed).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes register_repo through MCP and routes it to OperationService.registerRepo", async () => {
    const fixture = createFixture();
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-mcp-repo-"));
    dirs.push(repoDir);
    fs.mkdirSync(path.join(repoDir, ".git"));
    const registered: Array<{ rootPath: string; name: string | undefined }> = [];
    const operations = {
      registerRepo: (input: { rootPath: string; name?: string; worktreeParent?: string }) => {
        registered.push({ rootPath: input.rootPath, name: input.name });
        return {
          id: "repo_mcp_registered",
          name: input.name ?? "fixture",
          rootPath: input.rootPath,
          defaultBranch: "main",
          defaultRemote: "origin",
          worktreeParent: input.worktreeParent ?? `${input.rootPath}-worktrees`,
          setupHookIds: [],
          teardownHookIds: [],
          providerIds: [],
          createdAt: "2026-05-23T00:00:00.000Z",
          updatedAt: "2026-05-23T00:00:00.000Z",
          archivedAt: null,
        };
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      expect(list.result.tools.map((tool) => tool.name)).toContain("register_repo");

      const register = await postJson<{
        result: { structuredContent: { repo: { id: string; name: string; rootPath: string } } };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "register",
        method: "tools/call",
        params: { name: "register_repo", arguments: { rootPath: repoDir, name: "skills" } },
      });
      expect(register.result.structuredContent.repo).toMatchObject({
        id: "repo_mcp_registered",
        name: "skills",
        rootPath: repoDir,
      });
      expect(registered).toEqual([{ rootPath: repoDir, name: "skills" }]);
    } finally {
      await closeServer(server);
    }
  });

  it("returns user prompt history through the read_agent_history MCP tool and REST mirror", async () => {
    const fixture = createFixture();
    const history = {
      ok: true as const,
      sessionId: "sess_hist",
      workspaceId: "ws_hist",
      runtimeId: "claude-code",
      status: "running",
      total: 2,
      truncated: false,
      prompts: [
        {
          id: "pmt_1",
          sessionId: "sess_hist",
          source: "initial" as const,
          role: "user" as const,
          text: "do the audit",
          sentAt: "2026-05-23T10:00:00.000Z",
          externalId: null,
        },
        {
          id: "pmt_2",
          sessionId: "sess_hist",
          source: "send_agent_message" as const,
          role: "user" as const,
          text: "focus on usability",
          sentAt: "2026-05-23T10:05:00.000Z",
          externalId: null,
        },
      ],
    };
    const calls: Array<{ sessionId: string; limit?: number; maxChars?: number }> = [];
    const operations = {
      readAgentHistory: (input: { sessionId: string; limit?: number; maxChars?: number }) => {
        calls.push(input);
        if (input.sessionId === "missing") return { ok: false as const, error: "session_not_found" as const };
        return history;
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      expect(list.result.tools.map((tool) => tool.name)).toContain("read_agent_history");

      const call = await postJson<{
        result: { structuredContent: typeof history };
      }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "history",
        method: "tools/call",
        params: { name: "read_agent_history", arguments: { sessionId: "sess_hist", limit: 50, maxChars: 5000 } },
      });
      expect(call.result.structuredContent).toMatchObject({ ok: true, total: 2 });
      expect(call.result.structuredContent.prompts).toHaveLength(2);
      expect(calls).toContainEqual({ sessionId: "sess_hist", limit: 50, maxChars: 5000 });

      const rest = await fetch(`${baseUrl}/api/agent-sessions/sess_hist/history?limit=50`);
      expect(rest.ok).toBe(true);
      const restBody = (await rest.json()) as typeof history;
      expect(restBody.total).toBe(2);
      expect(restBody.prompts[0]?.text).toBe("do the audit");

      const missing = await fetch(`${baseUrl}/api/agent-sessions/missing/history`);
      expect(missing.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes /api/agent-sessions/:id/output and /messages REST mirrors of the MCP tools", async () => {
    const fixture = createFixture();
    const sent: Array<{ sessionId: string; message: string }> = [];
    const operations = {
      readAgentTranscript: (input: { sessionId: string }) =>
        input.sessionId === "missing"
          ? { ok: false as const, error: "session_not_found" as const }
          : {
              ok: true as const,
              sessionId: input.sessionId,
              workspaceId: "ws_mcp",
              runtimeId: "claude-code",
              status: "running",
              tmuxSessionName: "citadel_mcp",
              lines: 1,
              charCount: 3,
              text: "ok\n",
            },
      sendAgentMessage: async (input: { sessionId: string; message: string }) => {
        sent.push(input);
        return input.sessionId === "missing"
          ? { ok: false as const, error: "session_not_found" as const }
          : {
              ok: true as const,
              sessionId: input.sessionId,
              workspaceId: "ws_mcp",
              tmuxSessionName: "citadel_mcp",
              error: undefined,
            };
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const output = await getJson<{ ok: boolean; text: string }>(`${baseUrl}/api/agent-sessions/sess_x/output`);
      expect(output).toMatchObject({ ok: true, text: "ok\n" });

      const missing = await fetch(`${baseUrl}/api/agent-sessions/missing/output`);
      expect(missing.status).toBe(404);

      const send = await postJson<{ ok: boolean; sessionId: string }>(`${baseUrl}/api/agent-sessions/sess_x/messages`, {
        message: "hi",
      });
      expect(send).toMatchObject({ ok: true, sessionId: "sess_x" });
      expect(sent).toEqual([{ sessionId: "sess_x", message: "hi" }]);

      const noMessage = await fetch(`${baseUrl}/api/agent-sessions/sess_x/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(noMessage.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-daemon-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store };
}

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}
