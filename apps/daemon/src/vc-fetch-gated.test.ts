import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PullRequestSummary, Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { WorkspacePrSnapshot } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCache } from "./app-helpers.js";
import type { GhScheduler } from "./gh-scheduler.js";
import { globalPrCacheKey, writeGlobalPrSummary } from "./global-pr-cache.js";
import { type GatedVcFetchDeps, fetchVersionControlGated } from "./vc-fetch-gated.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeGitRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-vc-gated-"));
  dirs.push(repoPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
    cwd: repoPath,
    stdio: "pipe",
  });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
  return { repoPath, headSha };
}

function makePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 42,
    title: "Test PR",
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
    mergeable: "unknown",
    allowedMergeStrategies: [],
    mergeStateStatus: null,
    headSha: "abc123",
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Workspace",
    path: "/tmp/repo",
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeRepo(rootPath: string): Repo {
  return {
    id: "repo_a",
    name: "Repo",
    rootPath,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(rootPath, "..", "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
  };
}

function makeVc(pr: PullRequestSummary): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "healthy",
    reason: null,
    defaultBranch: "main",
    currentBranch: "feature",
    remotes: ["origin"],
    pullRequest: pr,
    checkedAt: new Date().toISOString(),
  };
}

function makeDeps(input: {
  cache: ProviderCache;
  snapshots: Map<string, Partial<WorkspacePrSnapshot>>;
  collectVc: GatedVcFetchDeps["collectVc"];
}): GatedVcFetchDeps {
  return {
    store: {
      getWorkspacePrSnapshot: (workspaceId: string) => input.snapshots.get(workspaceId) ?? null,
      updateWorkspacePrSnapshot: (workspaceId: string, patch: Partial<WorkspacePrSnapshot>) => {
        input.snapshots.set(workspaceId, { ...input.snapshots.get(workspaceId), ...patch });
      },
    } as never,
    scheduler: {
      shouldRefetch: () => ({ fetch: true }),
      recordFetch: () => {},
      recordFetchError: () => {},
      markRepoMainMoved: () => {},
      evict: () => {},
      invalidateNotDue: () => {},
      hydrate: () => {},
      _entries: () => new Map(),
    } as GhScheduler,
    providerCache: input.cache,
    collectVc: input.collectVc,
    resolveRepoFullName: () => "owner/repo",
    cachedProvider: async (key, load, ttlMs = 10_000) => {
      const cached = input.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value as never;
      const value = await load();
      input.cache.set(key, { expiresAt: Date.now() + ttlMs, value });
      return value as never;
    },
  };
}

describe("fetchVersionControlGated global PR cache", () => {
  it("serves a global cache hit without collecting from gh", async () => {
    const git = makeGitRepo();
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const pr = makePr({ headSha: git.headSha });
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 42), pr);
    let collectCalls = 0;
    const workspace = makeWorkspace({ path: git.repoPath });
    const deps = makeDeps({
      cache,
      snapshots: new Map([[workspace.id, { prNumber: 42 }]]),
      collectVc: async () => {
        collectCalls += 1;
        return makeVc(pr);
      },
    });

    const vc = await fetchVersionControlGated(deps, workspace, makeRepo(git.repoPath), `vc:${workspace.id}:1`);

    expect(collectCalls).toBe(0);
    expect(vc.pullRequest?.number).toBe(42);
    expect(vc.status).toBe("healthy");
  });

  it("discards a global cache hit when local HEAD differs", async () => {
    const git = makeGitRepo();
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 42), makePr({ headSha: "different" }));
    let collectCalls = 0;
    const fresh = makePr({ headSha: git.headSha, title: "Fresh" });
    const workspace = makeWorkspace({ path: git.repoPath });
    const deps = makeDeps({
      cache,
      snapshots: new Map([[workspace.id, { prNumber: 42 }]]),
      collectVc: async () => {
        collectCalls += 1;
        return makeVc(fresh);
      },
    });

    const vc = await fetchVersionControlGated(deps, workspace, makeRepo(git.repoPath), `vc:${workspace.id}:1`);

    expect(collectCalls).toBe(1);
    expect(vc.pullRequest?.title).toBe("Fresh");
  });

  it("writes successful fetches into the global PR cache", async () => {
    const git = makeGitRepo();
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const pr = makePr({ headSha: git.headSha });
    const workspace = makeWorkspace({ path: git.repoPath });
    const deps = makeDeps({
      cache,
      snapshots: new Map(),
      collectVc: async () => makeVc(pr),
    });

    await fetchVersionControlGated(deps, workspace, makeRepo(git.repoPath), `vc:${workspace.id}:1`);

    expect(cache.get(globalPrCacheKey("owner/repo", 42))?.value).toMatchObject({ number: 42 });
  });

  it("deduplicates concurrent misses for workspaces sharing one PR", async () => {
    const git = makeGitRepo();
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const pr = makePr({ headSha: git.headSha });
    let collectCalls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshots = new Map<string, Partial<WorkspacePrSnapshot>>([
      ["ws_a", { prNumber: 42 }],
      ["ws_b", { prNumber: 42 }],
    ]);
    const deps = makeDeps({
      cache,
      snapshots,
      collectVc: async () => {
        collectCalls += 1;
        await gate;
        return makeVc(pr);
      },
    });
    const repo = makeRepo(git.repoPath);
    const wsA = makeWorkspace({ id: "ws_a", path: git.repoPath });
    const wsB = makeWorkspace({ id: "ws_b", path: git.repoPath });

    const first = fetchVersionControlGated(deps, wsA, repo, "vc:ws_a:1");
    const second = fetchVersionControlGated(deps, wsB, repo, "vc:ws_b:1");
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(collectCalls).toBe(1);
    expect(a.pullRequest?.number).toBe(42);
    expect(b.pullRequest?.number).toBe(42);
  });

  it("synthesizes a degraded summary when local git metadata is unavailable", async () => {
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const pr = makePr({ headSha: "abc" });
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 42), pr);
    const workspace = makeWorkspace({ path: path.join(os.tmpdir(), "missing-citadel-repo") });
    const deps = makeDeps({
      cache,
      snapshots: new Map([[workspace.id, { prNumber: 42 }]]),
      collectVc: async () => makeVc(pr),
    });

    const vc = await fetchVersionControlGated(deps, workspace, makeRepo(workspace.path), `vc:${workspace.id}:1`);

    expect(vc.status).toBe("degraded");
    expect(vc.pullRequest?.number).toBe(42);
  });
});
