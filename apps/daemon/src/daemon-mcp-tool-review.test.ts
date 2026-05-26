import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import type { ReviewComment, ReviewSuggestionRun } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

describe("daemon MCP review tools", () => {
  it("add_review_comment stamps agent:unknown and refuses caller-supplied author OR runtimeId", async () => {
    const { fixture, workspaceId } = seedFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      // Baseline: a plain call with no identity field stamps 'agent:unknown'
      // (the schema doesn't declare runtimeId, and the daemon dispatcher does
      // not honor caller-supplied identity until the transport surfaces it).
      const addResp = await mcpCall<{ comment: ReviewComment }>(baseUrl, {
        name: "add_review_comment",
        arguments: { workspaceId, body: "hi from agent" },
      });
      expect(addResp.result.comment.author).toBe("agent:unknown");

      // Spoof attempt #1: explicit `author` is refused.
      const spoofAuthor = await mcpCall<{ error: string }>(baseUrl, {
        name: "add_review_comment",
        arguments: { workspaceId, body: "spoof", author: "operator" },
      });
      expect(spoofAuthor.result.error).toBe("author_not_allowed");

      // Spoof attempt #2: undocumented `runtimeId` is also refused.
      const spoofRuntime = await mcpCall<{ error: string }>(baseUrl, {
        name: "add_review_comment",
        arguments: { workspaceId, body: "spoof", runtimeId: "claude" },
      });
      expect(spoofRuntime.result.error).toBe("author_not_allowed");
    } finally {
      await closeServer(server);
    }
  });

  it("update_review_comment returns conflict on stale ifUpdatedAtMatches", async () => {
    const { fixture, workspaceId } = seedFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const add = await mcpCall<{ comment: ReviewComment }>(baseUrl, {
        name: "add_review_comment",
        arguments: { workspaceId, body: "v1" },
      });
      const stale = await mcpCall<{ error: string; latest: ReviewComment }>(baseUrl, {
        name: "update_review_comment",
        arguments: { id: add.result.comment.id, body: "v2", ifUpdatedAtMatches: "1970-01-01T00:00:00.000Z" },
      });
      expect(stale.result.error).toBe("conflict");
      expect(stale.result.latest.id).toBe(add.result.comment.id);
    } finally {
      await closeServer(server);
    }
  });

  it("request_review returns no-hook when nothing configured", async () => {
    const { fixture, workspaceId } = seedFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const resp = await mcpCall<{ error: string }>(baseUrl, {
        name: "request_review",
        arguments: { workspaceId },
      });
      expect(resp.result.error).toBe("no-hook");
    } finally {
      await closeServer(server);
    }
  });

  it("list_review_comments + delete_review_comment round-trip", async () => {
    const { fixture, workspaceId } = seedFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const add = await mcpCall<{ comment: ReviewComment }>(baseUrl, {
        name: "add_review_comment",
        arguments: { workspaceId, body: "to delete" },
      });
      const list = await mcpCall<{ comments: ReviewComment[] }>(baseUrl, {
        name: "list_review_comments",
        arguments: { workspaceId },
      });
      expect(list.result.comments).toHaveLength(1);

      const del = await mcpCall<{ ok: true }>(baseUrl, {
        name: "delete_review_comment",
        arguments: { id: add.result.comment.id, ifUpdatedAtMatches: add.result.comment.updatedAt },
      });
      expect(del.result.ok).toBe(true);

      const listAfter = await mcpCall<{ comments: ReviewComment[] }>(baseUrl, {
        name: "list_review_comments",
        arguments: { workspaceId },
      });
      expect(listAfter.result.comments).toHaveLength(0);
    } finally {
      await closeServer(server);
    }
  });
});

// --- helpers ---------------------------------------------------------------

function seedFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-mcp-review-"));
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
  const repoPath = path.join(dir, "repo");
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  const now = new Date().toISOString();
  store.insertRepo({
    id: "repo_1",
    name: "Repo",
    rootPath: repoPath,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "wt"),
    setupHookIds: [],
    teardownHookIds: [],
    requestReviewHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_1",
    repoId: "repo_1",
    name: "ws",
    path: repoPath,
    branch: "main",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "default",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return { fixture: { config, store, configPath }, workspaceId: "ws_1" };
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

async function mcpCall<T>(baseUrl: string, body: { name: string; arguments: Record<string, unknown> }) {
  const response = await fetch(`${baseUrl}/api/mcp/tools/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as { result: T };
}
