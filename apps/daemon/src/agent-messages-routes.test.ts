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
