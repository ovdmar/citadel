import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore, WorkspacePrSnapshot } from "@citadel/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GhScheduler } from "./gh-scheduler.js";
import { createGitHubProviderStateService } from "./github-provider-state.js";
import { createProviderCache } from "./provider-cache.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-github-state-"));
  dirs.push(dir);
  return dir;
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "w1",
    repoId: "repo",
    name: "w1",
    path: "/tmp/w1",
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
    archivedAt: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    ...overrides,
  };
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo",
    name: "repo",
    rootPath: "/tmp/repo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/repo/worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: "2026-05-25T00:00:00Z",
    updatedAt: "2026-05-25T00:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeVc(title = "fresh"): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "healthy",
    reason: null,
    defaultBranch: "main",
    currentBranch: "feature",
    remotes: ["origin"],
    pullRequest: {
      number: 42,
      title,
      url: "https://github.com/owner/repo/pull/42",
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
      mergeable: "unknown",
      allowedMergeStrategies: [],
      mergeStateStatus: null,
      headSha: "abc123",
    },
    checkedAt: new Date().toISOString(),
  };
}

function makeScheduler(): GhScheduler {
  return {
    shouldRefetch: () => ({ fetch: true }),
    recordFetch: () => {},
    recordFetchError: () => {},
    markRepoMainMoved: () => {},
    evict: () => {},
    invalidateNotDue: () => {},
    hydrate: () => {},
    _entries: () => new Map(),
  };
}

function makeService(input: {
  hasViewers?: boolean;
  collectVersionControl?: () => Promise<VersionControlSummary>;
  collectCi?: () => Promise<{
    providerId: "github-gh";
    status: "healthy";
    reason: null;
    checkedAt: string;
    runs: [];
  }>;
  snapshot?: Partial<WorkspacePrSnapshot> | null;
}) {
  const cache = createProviderCache({ dataDir: tempDataDir(), listLiveIds: () => ["w1", "repo"] });
  const store = {
    getWorkspacePrSnapshot: () => input.snapshot ?? null,
    updateWorkspacePrSnapshot: () => {},
  } as unknown as SqliteStore;
  const collectVersionControl = vi.fn(input.collectVersionControl ?? (async () => makeVc()));
  const collectCi = vi.fn(
    input.collectCi ??
      (async () => ({
        providerId: "github-gh" as const,
        status: "healthy" as const,
        reason: null,
        checkedAt: new Date().toISOString(),
        runs: [] as [],
      })),
  );
  const service = createGitHubProviderStateService({
    store,
    scheduler: makeScheduler(),
    providerCache: cache,
    collectVersionControl,
    collectCi,
    resolveRepoFullName: () => "owner/repo",
    cachedProvider: async (key, load, ttlMs = 10_000) => {
      const value = await load();
      cache.set(key, { expiresAt: Date.now() + ttlMs, value, cachedAt: Date.now() });
      return value;
    },
    cachedProviderSwr: async (key, load, ttlMs = 10_000) => {
      const value = await load();
      cache.set(key, { expiresAt: Date.now() + ttlMs, value, cachedAt: Date.now() });
      return value;
    },
    ghAutomationEnabled: true,
    hasViewers: () => input.hasViewers ?? false,
    msSinceLastViewer: () => Number.POSITIVE_INFINITY,
  });
  return { service, cache, collectVersionControl, collectCi };
}

describe("GitHub provider state service", () => {
  it("does not collect version control automatically when no cockpit viewer is connected", async () => {
    const { service, collectVersionControl } = makeService({});
    const vc = await service.fetchVersionControl(makeWorkspace(), makeRepo(), "vc:w1:1", { intent: "automatic" });
    expect(collectVersionControl).not.toHaveBeenCalled();
    expect(vc.status).toBe("unavailable");
    expect(vc.reason).toContain("paused");
  });

  it("serves cached version control during automatic no-viewer refresh", async () => {
    const { service, cache, collectVersionControl } = makeService({});
    cache.set("vc:w1:1", { expiresAt: Date.now() - 1, value: makeVc("cached"), cachedAt: Date.now() - 120_000 });
    const vc = await service.fetchVersionControl(makeWorkspace(), makeRepo(), "vc:w1:1", { intent: "automatic" });
    expect(collectVersionControl).not.toHaveBeenCalled();
    expect(vc.pullRequest?.title).toBe("cached");
  });

  it("allows interactive version-control reads to collect and populate cache", async () => {
    const { service, cache, collectVersionControl } = makeService({});
    const vc = await service.fetchVersionControl(makeWorkspace(), makeRepo(), "vc:w1:1", { intent: "interactive" });
    expect(collectVersionControl).toHaveBeenCalledTimes(1);
    expect(vc.pullRequest?.title).toBe("fresh");
    expect(cache.get("vc:w1:1")?.value).toMatchObject({ pullRequest: { title: "fresh" } });
  });

  it("does not collect CI automatically when no cockpit viewer is connected", async () => {
    const { service, collectCi } = makeService({});
    const ci = await service.fetchCi(makeWorkspace(), makeRepo(), { intent: "automatic" });
    expect(collectCi).not.toHaveBeenCalled();
    expect(ci.status).toBe("unavailable");
    expect(ci.reason).toContain("paused");
  });

  it("allows interactive CI reads to collect and populate cache", async () => {
    const { service, cache, collectCi } = makeService({
      snapshot: { prNumber: 42, prState: "open", lastHeadSha: "abc123", lastChecksGreenAt: null },
    });
    const ci = await service.fetchCi(makeWorkspace(), makeRepo(), { intent: "interactive" });
    expect(collectCi).toHaveBeenCalledTimes(1);
    expect(ci.status).toBe("healthy");
    expect(cache.get("ci:owner/repo:abc123")?.value).toMatchObject({ status: "healthy" });
  });

  it("does not collect interactive CI until PR metadata is known", async () => {
    const { service, collectCi } = makeService({});
    const ci = await service.fetchCi(makeWorkspace(), makeRepo(), { intent: "interactive" });
    expect(collectCi).not.toHaveBeenCalled();
    expect(ci.status).toBe("unavailable");
    expect(ci.reason).toContain("PR metadata");
  });

  it("mirrors CI refreshes to a supplied workspace cache key", async () => {
    const { service, cache, collectCi } = makeService({
      hasViewers: true,
      snapshot: { prNumber: 42, prState: "open", lastHeadSha: "abc123", lastChecksGreenAt: null },
    });
    const ci = await service.fetchCi(makeWorkspace(), makeRepo(), {
      cacheKey: "ci:w1:2026-05-25T00:00:00Z",
      intent: "automatic",
      ttlMs: 60_000,
    });
    expect(collectCi).toHaveBeenCalledTimes(1);
    expect(ci.status).toBe("healthy");
    expect(cache.get("ci:owner/repo:abc123")?.value).toMatchObject({ status: "healthy" });
    expect(cache.get("ci:w1:2026-05-25T00:00:00Z")?.value).toMatchObject({ status: "healthy" });
  });
});
