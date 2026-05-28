import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture, createGitFixtureWithRemote, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("PR diff route", () => {
  it("serves PR diff from local git without shelling out to gh", async () => {
    const fixture = createFixture(dirs);
    const git = createGitFixtureWithRemote(fixture.config.dataDir);
    fixture.config.providers.github.command = "definitely-missing-gh";
    execFileSync("git", ["checkout", "-b", "feature/local-diff"], { cwd: git.repoPath, stdio: "pipe" });
    fs.appendFileSync(path.join(git.repoPath, "README.md"), "local diff line\n");
    execFileSync("git", ["add", "README.md"], { cwd: git.repoPath, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "local diff"], { cwd: git.repoPath, stdio: "pipe" });
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_pr_diff",
      name: "PR Diff",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_pr_diff",
      repoId: "repo_pr_diff",
      name: "PR Diff Workspace",
      path: git.repoPath,
      branch: "feature/local-diff",
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
      const body = await getJson<{ provider: string; diff: string }>(`${baseUrl}/api/workspaces/ws_pr_diff/pr-diff`);
      expect(body.provider).toBe("local-git");
      expect(body.diff).toContain("+local diff line");
    } finally {
      await closeServer(server);
    }
  });
});
