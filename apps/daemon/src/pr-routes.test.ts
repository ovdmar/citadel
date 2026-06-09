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
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  setGithubCommand(undefined);
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

const createFixture = () => createFixtureBase(dirs);
const createGitRepo = (dir: string) => createGitRepoBase(dir);

type SnapshotRow = {
  prNumber: number | null;
  prState: "open" | "closed" | "merged" | null;
  lastFetchAt: string | null;
  lastChecksGreenAt: string | null;
  lastHeadSha: string | null;
  lastHeadShaChangedAt: string | null;
  lastMergeStateStatus: string | null;
};

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

    const { server } = await createDaemonApp({
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
    const { server } = await createDaemonApp({
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

  it("POST /api/workspaces/:id/pr-refresh can refresh an active checkout target", async () => {
    const fixture = createFixture();
    const now = "2026-06-05T00:00:00.000Z";
    const checkoutPath = path.join(fixture.config.dataDir, "structured", "api");
    fixture.store.insertRepo({
      id: "repo_api",
      name: "API",
      rootPath: path.join(fixture.config.dataDir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      providerRepositoryKey: "owner/api",
      showMainWorkspace: false,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    fixture.store.insertWorkspace({
      id: "ws_structured",
      repoId: null,
      name: "Structured",
      path: path.join(fixture.config.dataDir, "structured"),
      rootPath: path.join(fixture.config.dataDir, "structured"),
      mode: "structured",
      branch: "home",
      baseBranch: "main",
      source: "scratch",
      kind: "root",
      lifecyclePhase: "implementation",
      parentIssue: null,
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
    fixture.store.insertWorkspaceCheckout({
      id: "co_api",
      workspaceId: "ws_structured",
      repoId: "repo_api",
      name: "api",
      displayName: "API",
      path: checkoutPath,
      branch: "feature/api",
      baseBranch: "main",
      issue: null,
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    let seenRootPath = "";
    const { server } = await createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async (rootPath) => {
          seenRootPath = rootPath;
          const summary = makeVcSummary(now);
          return {
            ...summary,
            currentBranch: "feature/api",
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      const refresh = await postJson<{ versionControl: { currentBranch: string; pullRequest: { number: number } } }>(
        `${baseUrl}/api/workspaces/ws_structured/pr-refresh`,
        { checkoutId: "co_api" },
      );

      expect(seenRootPath).toBe(checkoutPath);
      expect(refresh.versionControl.currentBranch).toBe("feature/api");
      expect(refresh.versionControl.pullRequest.number).toBe(42);
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

  it("merge success marks cached PR state merged and only busts repo CI", async () => {
    const now = new Date().toISOString();
    const script = fakeGhScript("success");
    setGithubCommand(script);
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(globalPrCacheKey("owner/repo", 42), { expiresAt: Date.now() + 60_000, value: { number: 42 } });
    providerCache.set(`ci:repo_a:${now}`, { expiresAt: Date.now() + 60_000, value: "cached-ci" });
    providerCache.set(`vc:ws_a:${now}`, { expiresAt: Date.now() + 60_000, value: makeVcSummary(now) });
    const { server, snapshotUpdates } = createPrRouteHarness({
      providerCache,
      workspaceUpdatedAt: now,
      repoUpdatedAt: now,
    });
    const baseUrl = await listen(server);
    try {
      const result = await postJson<{ ok: true }>(`${baseUrl}/api/workspaces/ws_a/pr-merge`, { strategy: "squash" });

      expect(result).toEqual({ ok: true });
      expect(providerCache.has(`ci:repo_a:${now}`)).toBe(false);
      expect((providerCache.get(globalPrCacheKey("owner/repo", 42))?.value as { state?: string }).state).toBe("MERGED");
      expect(
        (
          providerCache.get(`vc:ws_a:${now}`)?.value as {
            pullRequest?: { state?: string; mergeable?: string; allowedMergeStrategies?: string[] };
          }
        ).pullRequest,
      ).toMatchObject({ state: "MERGED", mergeable: "unknown", allowedMergeStrategies: [] });
      expect(snapshotUpdates.at(-1)).toMatchObject({
        workspaceId: "ws_a",
        patch: { prNumber: 42, prState: "merged" },
      });
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
  const snapshotUpdates: Array<{ workspaceId: string; patch: Partial<SnapshotRow> }> = [];
  const snapshots = new Map<string, SnapshotRow>([
    [
      "ws_a",
      {
        prNumber: 42,
        prState: "open",
        lastFetchAt: now,
        lastChecksGreenAt: null,
        lastHeadSha: null,
        lastHeadShaChangedAt: null,
        lastMergeStateStatus: null,
      },
    ],
  ]);
  const app = express();
  app.use(express.json());
  const collectGitHubCiRuns =
    input.collectGitHubCiRuns ??
    (async () => ({
      providerId: "github-gh" as const,
      status: "healthy" as const,
      reason: null,
      runs: [] as [],
      checkedAt: now,
    }));
  const fetchVc = (cacheKey: string) =>
    cachedProviderValue(input.providerCache, cacheKey, async () => makeVcSummary(now), 90_000);
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
      getWorkspacePrSnapshot: (workspaceId: string) => snapshots.get(workspaceId) ?? null,
      updateWorkspacePrSnapshot: (workspaceId: string, patch: Partial<SnapshotRow>) => {
        snapshotUpdates.push({ workspaceId, patch });
        snapshots.set(workspaceId, { ...(snapshots.get(workspaceId) ?? nullSnapshot()), ...patch });
      },
    } as never,
    github: {
      fetchVersionControl: async (_workspace, _repo, cacheKey) => fetchVc(cacheKey),
      fetchCheckoutVersionControl: async (_workspace, _checkout, _repo, cacheKey) => fetchVc(cacheKey),
      fetchRepoVersionControl: async (_repo, cacheKey) => fetchVc(cacheKey),
      fetchRepoCi: async (_repo, cacheKey, options) =>
        cachedProviderValue(input.providerCache, cacheKey, collectGitHubCiRuns, options?.ttlMs ?? 180_000),
      fetchCi: async (_workspace, _repo, options) =>
        cachedProviderValue(input.providerCache, options?.cacheKey ?? `ci:ws_a:${now}`, collectGitHubCiRuns, 180_000),
      fetchCiRunLog: async (_repo, runId) => ({
        providerId: "github-gh",
        status: "healthy" as const,
        reason: null,
        runId,
        truncated: false,
        log: "log",
        checkedAt: now,
      }),
    },
    asyncRoute,
    providerCache: input.providerCache,
    resolveRepoFullName: () => "owner/repo",
    buildWorkspaceCockpitSummary: async () => null,
    ...(input.runHookEvent ? { operations: { runHookEvent: input.runHookEvent } as never } : {}),
  });
  return { server: http.createServer(app), snapshotUpdates };
}

function nullSnapshot(): SnapshotRow {
  return {
    prNumber: null,
    prState: null,
    lastFetchAt: null,
    lastChecksGreenAt: null,
    lastHeadSha: null,
    lastHeadShaChangedAt: null,
    lastMergeStateStatus: null,
  };
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
