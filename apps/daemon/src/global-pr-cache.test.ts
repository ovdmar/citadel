import type { PullRequestSummary, Workspace } from "@citadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bustGlobalPrEntry,
  classifyTtlMs,
  getInflight,
  globalPrCacheKey,
  globalPrCacheKeyForWorkspace,
  lookupGlobalPrByBranch,
  readGlobalPrSummary,
  registerInflight,
  writeGlobalPrSummary,
} from "./global-pr-cache.js";

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

function workspace(id: string, repoId = "repo_a"): Workspace {
  return {
    id,
    repoId,
    name: id,
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
  };
}

describe("global PR cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-27T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("classifies TTLs by PR state and checks", () => {
    expect(classifyTtlMs(makePr())).toBe(60_000);
    expect(
      classifyTtlMs(
        makePr({
          checks: [
            { name: "ci", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe(10 * 60_000);
    expect(classifyTtlMs(makePr({ state: "CLOSED" }))).toBe(Number.POSITIVE_INFINITY);
    expect(classifyTtlMs(makePr({ state: "MERGED" }))).toBe(Number.POSITIVE_INFINITY);
    expect(classifyTtlMs(makePr({ mergeable: "conflicting", mergeStateStatus: "DIRTY" }))).toBe(
      Number.POSITIVE_INFINITY,
    );
  });

  it("writes fresh entries and pins terminal PRs", () => {
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const key = globalPrCacheKey("owner/repo", 42);

    writeGlobalPrSummary(cache, key, makePr());
    expect(cache.get(key)?.expiresAt).toBe(Date.now() + 60_000);
    expect(readGlobalPrSummary(cache, key)?.number).toBe(42);

    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 43), makePr({ number: 43, state: "MERGED" }));
    expect(cache.get(globalPrCacheKey("owner/repo", 43))?.expiresAt).toBe(Number.POSITIVE_INFINITY);
    writeGlobalPrSummary(cache, key, makePr({ state: "MERGED" }));
    expect(cache.get(key)?.expiresAt).toBe(Number.POSITIVE_INFINITY);
    expect(readGlobalPrSummary(cache, key)?.number).toBe(42);
  });

  it("returns null after TTL expiry", () => {
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    const key = globalPrCacheKey("owner/repo", 42);
    writeGlobalPrSummary(cache, key, makePr());

    vi.advanceTimersByTime(60_001);

    expect(readGlobalPrSummary(cache, key)).toBeNull();
  });

  it("busts only the targeted key", () => {
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 42), makePr({ number: 42 }));
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 43), makePr({ number: 43 }));

    bustGlobalPrEntry(cache, "owner/repo", 42);

    expect(cache.has(globalPrCacheKey("owner/repo", 42))).toBe(false);
    expect(cache.has(globalPrCacheKey("owner/repo", 43))).toBe(true);
  });

  it("keeps key derivation invariant across workspaces sharing a PR", () => {
    const deps = {
      resolveRepoFullName: () => "owner/repo",
      getSnapshot: () => ({ prNumber: 42 }),
    };

    expect(globalPrCacheKey("owner/repo", 42)).toBe("pr:owner/repo#42");
    expect(globalPrCacheKeyForWorkspace(workspace("ws_a"), deps)).toBe("pr:owner/repo#42");
    expect(globalPrCacheKeyForWorkspace(workspace("ws_b"), deps)).toBe("pr:owner/repo#42");
  });

  it("looks up cached PRs by branch while respecting TTL", () => {
    const cache = new Map<string, { expiresAt: number; value: unknown }>();
    writeGlobalPrSummary(cache, globalPrCacheKey("owner/repo", 42), makePr({ headRefName: "parent" }));

    expect(lookupGlobalPrByBranch(cache, "owner/repo", "parent")?.number).toBe(42);
    vi.advanceTimersByTime(60_001);
    expect(lookupGlobalPrByBranch(cache, "owner/repo", "parent")).toBeNull();
  });

  it("tracks and clears single-flight promises", async () => {
    const key = globalPrCacheKey("owner/repo", 42);
    const promise = Promise.resolve(makePr());

    registerInflight(key, promise);
    expect(getInflight(key)).not.toBeNull();
    await expect(getInflight(key)).resolves.toMatchObject({ number: 42 });
    await Promise.resolve();
    expect(getInflight(key)).toBeNull();
  });
});
