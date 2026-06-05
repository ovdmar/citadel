import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo, VersionControlSummary, Workspace, WorktreeCheckout } from "@citadel/contracts";
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

function makeCheckout(overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id: "co_api",
    workspaceId: "w1",
    repoId: "repo",
    name: "api",
    path: "/tmp/w1/api",
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
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
  checkout?: WorktreeCheckout | null;
}) {
  const cache = createProviderCache({ dataDir: tempDataDir(), listLiveIds: () => ["w1", "repo"] });
  let checkout = input.checkout ?? null;
  const checkoutPrUpdates: unknown[] = [];
  const store = {
    getWorkspacePrSnapshot: () => input.snapshot ?? null,
    updateWorkspacePrSnapshot: () => {},
    findWorkspaceCheckout: () => checkout,
    updateWorkspaceCheckoutPr: (_id: string, pr: unknown) => {
      checkoutPrUpdates.push(pr);
      if (checkout) checkout = { ...checkout, intendedPr: pr as WorktreeCheckout["intendedPr"] };
      return checkout;
    },
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
  const collectCiRunLog = vi.fn(async (_rootPath: string, runId: string) => ({
    providerId: "github-gh" as const,
    status: "healthy" as const,
    reason: null,
    runId,
    truncated: false,
    log: "log",
    checkedAt: new Date().toISOString(),
  }));
  const service = createGitHubProviderStateService({
    store,
    scheduler: makeScheduler(),
    providerCache: cache,
    collectVersionControl,
    collectCi,
    collectCiRunLog,
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
  return { service, cache, collectVersionControl, collectCi, checkoutPrUpdates };
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
    expect(ci.status).toBe("healthy");
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

  it("checkout version-control reads collect from the checkout path and persist the PR binding", async () => {
    const checkout = makeCheckout();
    const { service, collectVersionControl, checkoutPrUpdates } = makeService({ hasViewers: true, checkout });

    const vc = await service.fetchCheckoutVersionControl(
      makeWorkspace({ kind: "root" }),
      checkout,
      makeRepo(),
      "vc:w1:checkout:co_api:2026-05-25T00:00:00Z",
      { intent: "interactive", force: true, staleWhileRevalidate: false },
    );

    expect(collectVersionControl).toHaveBeenCalledWith(checkout.path, expect.any(Object));
    expect(vc.pullRequest?.number).toBe(42);
    expect(checkoutPrUpdates.at(-1)).toMatchObject({
      provider: "github",
      number: 42,
      state: "open",
      headSha: "abc123",
      baseRef: "main",
    });
  });

  it("checkout version-control serves the last checkout PR snapshot when automatic refreshes are paused", async () => {
    const checkout = makeCheckout({
      intendedPr: {
        provider: "github",
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "open",
        headSha: "abc123",
        baseRef: "main",
        fetchedAt: "2026-05-25T00:00:00Z",
        checksGreen: null,
        mergeStateStatus: null,
        hasConflicts: null,
      },
    });
    const { service, collectVersionControl } = makeService({ checkout });

    const vc = await service.fetchCheckoutVersionControl(
      makeWorkspace({ kind: "root" }),
      checkout,
      makeRepo(),
      "vc:w1:checkout:co_api:2026-05-25T00:00:00Z",
      { intent: "automatic" },
    );

    expect(collectVersionControl).not.toHaveBeenCalled();
    expect(vc.pullRequest?.number).toBe(42);
    expect(vc.reason).toContain("served from PR snapshot");
  });
});
