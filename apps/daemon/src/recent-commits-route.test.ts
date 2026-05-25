import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture, createGitRepo, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("recent-commits route", () => {
  it("returns 404 for unknown workspace ids and clamps the `limit` query param", async () => {
    const fixture = createFixture(dirs);
    const git = createGitRepo(String(fixture.config.dataDir));
    // Build a small history so we can prove clamping picks N commits.
    for (let i = 0; i < 4; i += 1) {
      fs.writeFileSync(path.join(git.repoPath, "tracked.txt"), `commit ${i}\n`);
      execFileSync("git", ["add", "."], { cwd: git.repoPath, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", `commit ${i}`], { cwd: git.repoPath, stdio: "pipe" });
    }
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_recent",
      name: "recent",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: String(fixture.config.dataDir),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_recent",
      repoId: "repo_recent",
      name: "recent",
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
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      namespaceId: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const notFound = await fetch(`${baseUrl}/api/workspaces/ws_missing/recent-commits`);
      expect(notFound.status).toBe(404);
      expect(await notFound.json()).toEqual({ error: "workspace_not_found" });

      const defaultLimit = await getJson<{ workspaceId: string; commits: unknown[] }>(
        `${baseUrl}/api/workspaces/ws_recent/recent-commits`,
      );
      expect(defaultLimit.workspaceId).toBe("ws_recent");
      // Repo has 5 commits (initial + 4); default limit is 8 so we get all 5.
      expect(defaultLimit.commits).toHaveLength(5);

      const capped = await getJson<{ commits: unknown[] }>(
        `${baseUrl}/api/workspaces/ws_recent/recent-commits?limit=2`,
      );
      expect(capped.commits).toHaveLength(2);

      // Invalid/negative/oversized limits fall back to the default ceiling.
      for (const probe of ["abc", "0", "-3"]) {
        const fallback = await getJson<{ commits: unknown[] }>(
          `${baseUrl}/api/workspaces/ws_recent/recent-commits?limit=${probe}`,
        );
        expect(fallback.commits).toHaveLength(5);
      }
      const clamped = await getJson<{ commits: unknown[] }>(
        `${baseUrl}/api/workspaces/ws_recent/recent-commits?limit=9999`,
      );
      // Limit is clamped to 50 (then bounded by actual commit count = 5).
      expect(clamped.commits).toHaveLength(5);
    } finally {
      await closeServer(server);
    }
  });
});
