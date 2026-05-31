import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setGithubCommand } from "@citadel/providers";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { asyncRoute, cachedProviderValue } from "./app-helpers.js";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitRepo as createGitRepoBase,
  getJson,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";
import { globalPrCacheKey } from "./global-pr-cache.js";
import { registerPrRoutes } from "./pr-routes.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  setGithubCommand(undefined);
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

  it("repo CI route caches under repo identity with 180s TTL", async () => {
    const now = new Date("2026-05-27T00:00:00.000Z").toISOString();
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    const { server } = createPrRouteHarness({
      providerCache,
      repoUpdatedAt: now,
      collectGitHubCiRuns: async () => ({
        providerId: "github-gh",
        status: "healthy" as const,
        reason: null,
        runs: [],
        checkedAt: now,
      }),
    });
    const baseUrl = await listen(server);
    try {
      await getJson(`${baseUrl}/api/repos/repo_a/ci-runs`);

      expect(providerCache.has(`ci:repo_a:${now}`)).toBe(true);
      expect(providerCache.has(`ci:ws_a:${now}`)).toBe(false);
      expect((providerCache.get(`ci:repo_a:${now}`)?.expiresAt ?? 0) - Date.now()).toBeGreaterThan(170_000);
    } finally {
      await closeServer(server);
    }
  });

  it("merge success busts workspace VC, repo CI, and the global PR cache entry", async () => {
    const now = new Date().toISOString();
    const script = fakeGhScript("success");
    setGithubCommand(script);
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(globalPrCacheKey("owner/repo", 42), { expiresAt: Date.now() + 60_000, value: { number: 42 } });
    providerCache.set(`ci:repo_a:${now}`, { expiresAt: Date.now() + 60_000, value: "cached-ci" });
    providerCache.set(`vc:ws_a:${now}`, { expiresAt: Date.now() + 60_000, value: makeVcSummary(now) });
    const { server } = createPrRouteHarness({ providerCache, workspaceUpdatedAt: now, repoUpdatedAt: now });
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{ ok: true }>(`${baseUrl}/api/workspaces/ws_a/pr-merge`, { strategy: "squash" });

      expect(result).toEqual({ ok: true });
      expect(providerCache.has(globalPrCacheKey("owner/repo", 42))).toBe(false);
      expect(providerCache.has(`ci:repo_a:${now}`)).toBe(false);
      expect(providerCache.has(`vc:ws_a:${now}`)).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("runs pr.merge hooks as the merge handler when present", async () => {
    const now = new Date().toISOString();
    const script = fakeGhScript("strategy-failure");
    setGithubCommand(script);
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(globalPrCacheKey("owner/repo", 42), { expiresAt: Date.now() + 60_000, value: { number: 42 } });
    const hookCalls: Array<{ event: string; payload: unknown }> = [];
    const { server } = createPrRouteHarness({
      providerCache,
      workspaceUpdatedAt: now,
      repoUpdatedAt: now,
      runHookEvent: async (input) => {
        hookCalls.push({ event: input.event, payload: input.payload });
        return { operationId: "op_pr_merge", ran: 1 };
      },
    });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_a/pr-merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "squash" }),
      });
      const result = (await response.json()) as { ok: true };

      expect(response.status).toBe(202);
      expect(result).toEqual({ ok: true });
      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0]?.event).toBe("pr.merge");
      expect(hookCalls[0]?.payload).toMatchObject({ strategy: "squash", pullRequest: { number: 42 } });
      expect(providerCache.has(globalPrCacheKey("owner/repo", 42))).toBe(false);
    } finally {
      await closeServer(server);
    }
  });

  it("merge strategy failures bust the repo merge-strategies cache", async () => {
    const now = new Date().toISOString();
    const script = fakeGhScript("strategy-failure");
    setGithubCommand(script);
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set("gh-repo-merge-strategies:owner/repo", { expiresAt: Date.now() + 60_000, value: "cached" });
    providerCache.set(`vc:ws_a:${now}`, { expiresAt: Date.now() + 60_000, value: makeVcSummary(now) });
    const { server } = createPrRouteHarness({ providerCache, workspaceUpdatedAt: now, repoUpdatedAt: now });
    const baseUrl = await listen(server);
    try {
      const response = await fetch(`${baseUrl}/api/workspaces/ws_a/pr-merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: "rebase" }),
      });

      expect(response.status).toBe(409);
      expect(providerCache.has("gh-repo-merge-strategies:owner/repo")).toBe(false);
    } finally {
      await closeServer(server);
    }
  });
});

function createPrRouteHarness(input: {
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  workspaceUpdatedAt?: string;
  repoUpdatedAt?: string;
  runHookEvent?: (input: { event: string; payload: unknown }) => Promise<{ operationId: string; ran: number }>;
  collectGitHubCiRuns?: () => Promise<{
    providerId: "github-gh";
    status: "healthy";
    reason: null;
    runs: [];
    checkedAt: string;
  }>;
}) {
  const now = new Date().toISOString();
  const workspaceUpdatedAt = input.workspaceUpdatedAt ?? now;
  const repoUpdatedAt = input.repoUpdatedAt ?? now;
  const app = express();
  app.use(express.json());
  registerPrRoutes({
    app,
    store: {
      listRepos: () => [
        {
          id: "repo_a",
          name: "Repo",
          rootPath: process.cwd(),
          defaultBranch: "main",
          defaultRemote: "origin",
          worktreeParent: "/tmp/worktrees",
          setupHookIds: [],
          teardownHookIds: [],
          providerIds: ["github-gh"],
          deployHookCommand: null,
          createdAt: now,
          updatedAt: repoUpdatedAt,
          archivedAt: null,
        },
      ],
      listWorkspaces: () => [
        {
          id: "ws_a",
          repoId: "repo_a",
          name: "Workspace",
          path: process.cwd(),
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
          updatedAt: workspaceUpdatedAt,
          archivedAt: null,
        },
      ],
      getWorkspacePrSnapshot: () => ({ prNumber: 42 }),
    } as never,
    providers: {
      collectGitHubVersionControlSummary: async () => makeVcSummary(now),
      collectGitHubCiRuns:
        input.collectGitHubCiRuns ??
        (async () => ({
          providerId: "github-gh",
          status: "healthy" as const,
          reason: null,
          runs: [],
          checkedAt: now,
        })),
      collectGitHubCiRunLog: async () => ({ providerId: "github-gh", status: "healthy" as const, reason: null }),
    } as never,
    asyncRoute,
    cachedProvider: (key, load, ttlMs) => cachedProviderValue(input.providerCache, key, load, ttlMs),
    providerCache: input.providerCache,
    resolveRepoFullName: () => "owner/repo",
    buildWorkspaceCockpitSummary: async () => null,
    ...(input.runHookEvent ? { operations: { runHookEvent: input.runHookEvent } as never } : {}),
  });
  return { server: http.createServer(app) };
}

function makeVcSummary(checkedAt: string) {
  return {
    providerId: "github-gh",
    status: "healthy" as const,
    reason: null,
    defaultBranch: "main",
    currentBranch: "feature",
    remotes: ["origin"],
    pullRequest: {
      number: 42,
      title: "PR",
      url: "https://example.test/pr/42",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
      additions: null,
      deletions: null,
      reviewers: [],
      commits: [],
      headRefName: "feature",
      parentPr: null,
      mergeable: "unknown" as const,
      allowedMergeStrategies: [],
      mergeStateStatus: null,
      headSha: null,
    },
    checkedAt,
  };
}

function fakeGhScript(mode: "success" | "strategy-failure"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-fake-gh-"));
  dirs.push(dir);
  const script = path.join(dir, "gh");
  fs.writeFileSync(
    script,
    mode === "success"
      ? "#!/usr/bin/env bash\nexit 0\n"
      : "#!/usr/bin/env bash\necho 'rebase merge is not allowed by repository' >&2\nexit 1\n",
  );
  fs.chmodSync(script, 0o755);
  return script;
}
