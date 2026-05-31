import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmuxPrefix } from "@citadel/terminal";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitFixtureWithRemote as createGitFixtureWithRemoteBase,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];
const tmuxSessions: string[] = [];

afterEach(() => {
  for (const session of tmuxSessions.splice(0)) {
    try {
      execFileSync("tmux", [...tmuxPrefix(), "kill-session", "-t", session], { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

describe("daemon launch_agent MCP tool", () => {
  it("creates a workspace on a brand-new branch and is idempotent on workspaceName", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemoteBase(fixture.config.dataDir);
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const repoResp = await postJson<{ repo: { id: string; name: string } }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "launch-mcp-fixture",
      });

      const firstResp = await postJson<{
        result: { workspaceId: string; sessionId: string; branchName: string; resumed?: boolean };
      }>(`${baseUrl}/api/mcp/tools/call`, {
        name: "launch_agent",
        arguments: {
          repoId: repoResp.repo.id,
          prompt: "hello",
          runtimeId: "shell",
          workspaceName: "mcp-idem",
          branchName: "fb-brand-new-mcp",
        },
      });
      const first = firstResp.result;
      tmuxSessions.push(`citadel_${first.sessionId}`);
      expect(first.workspaceId).toBeTruthy();
      expect(first.sessionId).toBeTruthy();
      expect(first.branchName).toBe("fb-brand-new-mcp");
      expect(first.resumed).toBeUndefined();

      const secondResp = await postJson<{
        result: { workspaceId: string; sessionId: string; resumed?: boolean };
      }>(`${baseUrl}/api/mcp/tools/call`, {
        name: "launch_agent",
        arguments: {
          repoId: repoResp.repo.id,
          prompt: "again",
          runtimeId: "shell",
          workspaceName: "mcp-idem",
          branchName: "fb-brand-new-mcp",
        },
      });
      const second = secondResp.result;
      expect(second.resumed).toBe(true);
      expect(second.workspaceId).toBe(first.workspaceId);
      expect(second.sessionId).toBe(first.sessionId);
    } finally {
      await closeServer(server);
    }
  }, 20_000);
});
