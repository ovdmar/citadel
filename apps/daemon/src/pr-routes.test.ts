import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitRepo as createGitRepoBase,
  getJson,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

const createFixture = () => createFixtureBase(dirs);
const createGitRepo = (dir: string) => createGitRepoBase(dir);

describe("PR routes", () => {
  it("POST /api/workspaces/cockpit-summary/batch returns per-workspace envelope with partial failures", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_batch",
      name: "Batch",
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
      id: "ws_ok",
      repoId: "repo_batch",
      name: "ws_ok",
      path: git.repoPath,
      branch: "feature",
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
    // Root workspaces are rejected cheaply by the batch endpoint (no gh spawn).
    fixture.store.insertWorkspace({
      id: "ws_root",
      repoId: "repo_batch",
      name: "ws_root",
      path: path.join(git.repoPath, "..", "ws_root_unused"),
      branch: "main",
      baseBranch: "main",
      source: "scratch",
      kind: "root",
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

    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => ({
          providerId: "github-gh",
          status: "healthy" as const,
          reason: null,
          defaultBranch: "main",
          currentBranch: "feature",
          remotes: ["origin"],
          pullRequest: null,
          checkedAt: now,
        }),
        collectGitHubCiRuns: async () => ({
          providerId: "github-gh",
          status: "healthy" as const,
          reason: null,
          runs: [],
          checkedAt: now,
        }),
      },
    });
    const baseUrl = await listen(server);
    try {
      const body = await postJson<{
        summaries: Array<
          | { workspaceId: string; ok: true; summary: { workspaceId: string } }
          | { workspaceId: string; ok: false; reason: string }
        >;
      }>(`${baseUrl}/api/workspaces/cockpit-summary/batch`, { ids: ["ws_ok", "ws_root", "ws_missing"] });

      const byId = Object.fromEntries(body.summaries.map((entry) => [entry.workspaceId, entry] as const));
      expect(byId.ws_ok).toMatchObject({ ok: true });
      expect(byId.ws_root).toMatchObject({ ok: false, reason: "root-workspace" });
      expect(byId.ws_missing).toMatchObject({ ok: false, reason: "workspace_not_found" });

      // 400 on empty ids.
      const empty = await fetch(`${baseUrl}/api/workspaces/cockpit-summary/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: [] }),
      });
      expect(empty.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("POST /api/workspaces/:id/pr-refresh busts cache and returns fresh versionControl", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_refresh",
      name: "Refresh",
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
      id: "ws_refresh",
      repoId: "repo_refresh",
      name: "Refresh",
      path: git.repoPath,
      branch: "feature",
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
    let calls = 0;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => {
          calls += 1;
          return {
            providerId: "github-gh",
            status: "healthy" as const,
            reason: null,
            defaultBranch: "main",
            currentBranch: "feature",
            remotes: ["origin"],
            pullRequest: null,
            checkedAt: `${now}-call-${calls}`,
          };
        },
        collectGitHubCiRuns: async () => ({
          providerId: "github-gh",
          status: "healthy" as const,
          reason: null,
          runs: [],
          checkedAt: now,
        }),
      },
    });
    const baseUrl = await listen(server);
    try {
      // Prime the cache via the single-workspace endpoint.
      await getJson(`${baseUrl}/api/workspaces/ws_refresh/cockpit-summary`);
      const before = calls;
      // Refresh forces a re-collect by busting the prefix.
      const refresh = await postJson<{ versionControl: { checkedAt: string } }>(
        `${baseUrl}/api/workspaces/ws_refresh/pr-refresh`,
        {},
      );
      expect(calls).toBeGreaterThan(before);
      expect(refresh.versionControl.checkedAt).toContain(`call-${calls}`);
    } finally {
      await closeServer(server);
    }
  });
});
