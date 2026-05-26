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

describe("review routes — comments", () => {
  it("supports a POST → GET → PATCH(409) → PATCH(200) → DELETE round-trip", async () => {
    const fixture = createFixture();
    const { repoId, workspaceId } = seedRepoAndWorkspace(fixture);
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      // 404 on unknown workspace
      const unknown = await fetch(`${baseUrl}/api/workspaces/ws_missing/review-comments`);
      expect(unknown.status).toBe(404);

      // POST 201
      const created = await postJson<{ comment: ReviewComment }>(
        `${baseUrl}/api/workspaces/${workspaceId}/review-comments`,
        { body: "Looks good but check this edge case" },
      );
      expect(created.comment.author).toBe("operator");
      expect(created.comment.workspaceId).toBe(workspaceId);

      // Second comment via clean body — confirms author stays 'operator' even
      // on subsequent posts.
      await postJson<{ comment: ReviewComment }>(`${baseUrl}/api/workspaces/${workspaceId}/review-comments`, {
        body: "another",
      });

      // GET 200 with two comments
      const list = await getJson<{ comments: ReviewComment[] }>(
        `${baseUrl}/api/workspaces/${workspaceId}/review-comments`,
      );
      expect(list.comments).toHaveLength(2);
      expect(list.comments.every((c) => c.author === "operator")).toBe(true);

      // PATCH 409 with stale token
      const stale = await fetch(`${baseUrl}/api/review-comments/${created.comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "v2", ifUpdatedAtMatches: "1970-01-01T00:00:00.000Z" }),
      });
      expect(stale.status).toBe(409);

      // PATCH 200 with fresh token
      const fresh = await fetch(`${baseUrl}/api/review-comments/${created.comment.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "resolved", ifUpdatedAtMatches: created.comment.updatedAt }),
      });
      expect(fresh.status).toBe(200);
      const updated = (await fresh.json()) as { comment: ReviewComment };
      expect(updated.comment.status).toBe("resolved");

      // DELETE 204 with fresh token
      const del = await fetch(`${baseUrl}/api/review-comments/${created.comment.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ifUpdatedAtMatches: updated.comment.updatedAt }),
      });
      expect(del.status).toBe(204);

      // GET hides soft-deleted by default
      const after = await getJson<{ comments: ReviewComment[] }>(
        `${baseUrl}/api/workspaces/${workspaceId}/review-comments`,
      );
      expect(after.comments).toHaveLength(1);
      expect(after.comments[0]?.id).not.toBe(created.comment.id);

      // includeDeleted=true brings it back
      const withDeleted = await getJson<{ comments: ReviewComment[] }>(
        `${baseUrl}/api/workspaces/${workspaceId}/review-comments?includeDeleted=true`,
      );
      expect(withDeleted.comments).toHaveLength(2);
    } finally {
      await closeServer(server);
    }
    // ensure repoId is referenced for the typed fixture
    expect(repoId).toMatch(/^repo_/);
  });

  it("rejects an add request that supplies an author field", async () => {
    const fixture = createFixture();
    const { workspaceId } = seedRepoAndWorkspace(fixture);
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const r = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/review-comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: "hi", author: "agent:rogue" }),
      });
      expect(r.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });
});

describe("review routes — request_review", () => {
  it("returns no-hook when none configured", async () => {
    const fixture = createFixture();
    const { workspaceId } = seedRepoAndWorkspace(fixture);
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const r = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/review-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(400);
      expect((await r.json()) as { error: string }).toEqual({ error: "no-hook" });
    } finally {
      await closeServer(server);
    }
  });

  it("returns parsed suggestions when the configured hook succeeds", async () => {
    const fixture = createFixture();
    const { workspaceId } = seedRepoAndWorkspace(fixture, {
      hookCommand: "node",
      hookArgs: [
        "-e",
        "process.stdout.write(JSON.stringify({suggestions:[{id:'s1',kind:'reviewer',label:'@alice'}]}))",
      ],
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const r = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/review-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { run: ReviewSuggestionRun; output: { suggestions: { id: string }[] } };
      expect(body.output.suggestions[0]?.id).toBe("s1");
      // GET latest matches
      const latest = await getJson<{ run: ReviewSuggestionRun | null }>(
        `${baseUrl}/api/workspaces/${workspaceId}/review-suggestions`,
      );
      expect(latest.run?.status).toBe("succeeded");
    } finally {
      await closeServer(server);
    }
  });
});

// --- helpers ---------------------------------------------------------------

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-review-routes-"));
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

function seedRepoAndWorkspace(
  fixture: ReturnType<typeof createFixture>,
  opts: { hookCommand?: string; hookArgs?: string[] } = {},
) {
  const git = createGitRepo(fixture.config.dataDir);
  const now = new Date().toISOString();
  const repoId = `repo_${Date.now().toString(36)}`;
  const requestReviewHookIds: string[] = [];
  if (opts.hookCommand) {
    const hookId = `rev_${Date.now().toString(36)}`;
    fixture.config.hooks = [
      ...(fixture.config.hooks ?? []),
      {
        id: hookId,
        kind: "command",
        event: "workspace.requestReview",
        command: opts.hookCommand,
        args: opts.hookArgs ?? [],
        blocking: true,
      },
    ];
    requestReviewHookIds.push(hookId);
  }
  fixture.store.insertRepo({
    id: repoId,
    name: "Repo",
    rootPath: git.repoPath,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    requestReviewHookIds,
    providerIds: [],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  const workspaceId = `ws_${Date.now().toString(36)}`;
  fixture.store.insertWorkspace({
    id: workspaceId,
    repoId,
    name: "ws",
    path: git.repoPath,
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
  return { repoId, workspaceId };
}

function createGitRepo(dir: string) {
  const repoPath = path.join(dir, `repo-${Date.now().toString(36)}`);
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  return { repoPath };
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
  return response.json() as Promise<T>;
}
