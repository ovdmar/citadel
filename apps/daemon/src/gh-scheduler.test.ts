import type { PullRequestSummary } from "@citadel/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createGhScheduler, type GhScheduler, type HydrateRow, makeKey } from "./gh-scheduler.js";

// Controllable clock + viewer + cooldown deps. Tests advance time via
// `clock.t = ...` rather than relying on real Date.now() so we can probe
// cadence boundaries cleanly.
type Harness = {
  clock: { t: number };
  viewers: { has: boolean; lastDetachAt: number | null };
  cooldown: { until: number | null };
  scheduler: GhScheduler;
};

function makeHarness(opts: { hasViewers?: boolean } = {}): Harness {
  const clock = { t: 1_000_000 };
  const viewers = { has: opts.hasViewers ?? true, lastDetachAt: null as number | null };
  const cooldown = { until: null as number | null };
  const scheduler = createGhScheduler({
    hasViewers: () => viewers.has,
    msSinceLastViewer: () => (viewers.lastDetachAt === null ? 0 : clock.t - viewers.lastDetachAt),
    getGhCooldown: () => (cooldown.until === null ? null : { until: cooldown.until }),
    now: () => clock.t,
  });
  return { clock, viewers, cooldown, scheduler };
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
    headSha: "abc1234",
    ...overrides,
  };
}

describe("gh-scheduler — shouldRefetch", () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it("fetches on first call (no entry yet)", () => {
    expect(h.scheduler.shouldRefetch(makeKey("o/r", 1))).toEqual({ fetch: true });
  });

  it("skips with reason 'merged' forever once state is MERGED", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr({ state: "MERGED" }), "ws_a");
    h.clock.t += 60 * 60_000; // 1 hour later
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "merged" });
    h.clock.t += 24 * 60 * 60_000; // 1 day later
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "merged" });
  });

  it("default-open cadence is 60s — skip at 30s, fetch at 61s", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.clock.t += 30_000;
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "not-due" });
    h.clock.t += 31_000; // total 61s
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: true });
  });

  it("pending checks cadence is 60s (pending AND headSha changed <10min ago)", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(
      key,
      makePr({
        checks: [
          { name: "ci", status: "in_progress", conclusion: null, url: null, startedAt: null, completedAt: null },
        ],
      }),
      "ws_a",
    );
    h.clock.t += 59_000;
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "not-due" });
    h.clock.t += 2_000; // total 61s
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: true });
  });

  it("green-checks-and-old cadence is 3 min", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(
      key,
      makePr({
        checks: [{ name: "ci", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null }],
      }),
      "ws_a",
    );
    // Age the headSha past 10min.
    h.clock.t += 11 * 60_000;
    // Refetch with same SHA to re-evaluate cadence based on aged shaChangedAt.
    h.scheduler.recordFetch(
      key,
      makePr({
        checks: [{ name: "ci", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null }],
      }),
      "ws_a",
    );
    // Now 3-min cadence applies.
    h.clock.t += 2 * 60_000 + 30_000; // 2m30s after the latest fetch
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "not-due" });
    h.clock.t += 31_000; // total 3m01s
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: true });
  });

  it("skips with 'cooldown' regardless of cadence", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.cooldown.until = h.clock.t + 10 * 60_000;
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "cooldown" });
  });

  it("skips with 'no-viewers' after grace expires", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.viewers.has = false;
    h.viewers.lastDetachAt = h.clock.t;
    h.clock.t += 90_000; // within grace
    expect(h.scheduler.shouldRefetch(key)).not.toEqual({ fetch: false, reason: "no-viewers" });
    h.clock.t += 31_000; // total 121s — past grace
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "no-viewers" });
  });

  it("force:true overrides not-due but is still blocked by cooldown", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.clock.t += 10_000;
    expect(h.scheduler.shouldRefetch(key, { force: true })).toEqual({ fetch: true });
    h.cooldown.until = h.clock.t + 60_000;
    expect(h.scheduler.shouldRefetch(key, { force: true })).toEqual({ fetch: false, reason: "cooldown" });
  });

  it("precedence: cooldown wins over backoff", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetchError(key, new Error("auth fail"));
    h.cooldown.until = h.clock.t + 60_000;
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "cooldown" });
  });

  it("precedence: cooldown wins over no-viewers (cooldown reported first)", () => {
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.viewers.has = false;
    h.viewers.lastDetachAt = h.clock.t - 200_000;
    h.cooldown.until = h.clock.t + 60_000;
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "cooldown" });
  });
});

describe("gh-scheduler — recordFetch", () => {
  it("updates lastHeadShaChangedAt only when headSha actually changes", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr({ headSha: "aaa" }), "ws_a");
    const initial = h.scheduler._entries().get(key)!.lastHeadShaChangedAt;
    h.clock.t += 30_000;
    h.scheduler.recordFetch(key, makePr({ headSha: "aaa" }), "ws_a"); // same SHA
    expect(h.scheduler._entries().get(key)!.lastHeadShaChangedAt).toBe(initial);
    h.clock.t += 30_000;
    h.scheduler.recordFetch(key, makePr({ headSha: "bbb" }), "ws_a"); // new SHA
    expect(h.scheduler._entries().get(key)!.lastHeadShaChangedAt).toBe(h.clock.t);
  });

  it("resets consecutiveErrors to 0 on success", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetchError(key, new Error("x"));
    h.scheduler.recordFetchError(key, new Error("x"));
    expect(h.scheduler._entries().get(key)!.consecutiveErrors).toBe(2);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    expect(h.scheduler._entries().get(key)!.consecutiveErrors).toBe(0);
  });

  it("tracks all workspaceIds that touched the entry", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    h.scheduler.recordFetch(key, makePr(), "ws_b");
    h.scheduler.recordFetch(key, makePr(), "ws_a");
    const entry = h.scheduler._entries().get(key)!;
    expect([...entry.workspaceIds].sort()).toEqual(["ws_a", "ws_b"]);
  });
});

describe("gh-scheduler — recordFetchError exponential backoff", () => {
  it("extends nextEligibleAt: 60s → 120s → 240s → 300s cap", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 1);
    const expectedDelays = [60_000, 120_000, 240_000, 300_000, 300_000];
    for (const delay of expectedDelays) {
      const at = h.clock.t;
      h.scheduler.recordFetchError(key, new Error("x"));
      const entry = h.scheduler._entries().get(key)!;
      expect(entry.nextEligibleAt - at).toBe(delay);
      // Advance just past the backoff window so the next error starts fresh
      // relative to the latest fetch time.
      h.clock.t = entry.nextEligibleAt + 1;
    }
  });

  it("shouldRefetch returns 'backoff' inside the backoff window", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 1);
    h.scheduler.recordFetchError(key, new Error("x"));
    h.clock.t += 30_000; // inside 60s backoff
    expect(h.scheduler.shouldRefetch(key)).toEqual({ fetch: false, reason: "backoff" });
  });

  it("installs a sentinel entry on first-fetch error", () => {
    const h = makeHarness();
    const key = makeKey("o/r", 999);
    h.scheduler.recordFetchError(key, new Error("x"));
    const entry = h.scheduler._entries().get(key);
    expect(entry).toBeDefined();
    expect(entry?.consecutiveErrors).toBe(1);
    expect(entry?.state).toBe("open");
  });
});

describe("gh-scheduler — markRepoMainMoved", () => {
  it("flips needsMergeStateRefresh for every PR matching the repo, leaves others alone", () => {
    const h = makeHarness();
    const k1 = makeKey("o/r1", 1);
    const k2 = makeKey("o/r1", 2);
    const k3 = makeKey("o/r2", 7);
    h.scheduler.recordFetch(k1, makePr({ number: 1 }), "ws_1");
    h.scheduler.recordFetch(k2, makePr({ number: 2 }), "ws_2");
    h.scheduler.recordFetch(k3, makePr({ number: 7 }), "ws_3");
    h.scheduler.markRepoMainMoved("o/r1");
    expect(h.scheduler._entries().get(k1)!.needsMergeStateRefresh).toBe(true);
    expect(h.scheduler._entries().get(k2)!.needsMergeStateRefresh).toBe(true);
    expect(h.scheduler._entries().get(k3)!.needsMergeStateRefresh).toBe(false);
  });

  it("does not flip merged PRs", () => {
    const h = makeHarness();
    const k = makeKey("o/r", 1);
    h.scheduler.recordFetch(k, makePr({ state: "MERGED" }), "ws_a");
    h.scheduler.markRepoMainMoved("o/r");
    expect(h.scheduler._entries().get(k)!.needsMergeStateRefresh).toBe(false);
  });

  it("makes shouldRefetch return fetch:true on next call regardless of cadence", () => {
    const h = makeHarness();
    const k = makeKey("o/r", 1);
    h.scheduler.recordFetch(k, makePr(), "ws_a");
    h.clock.t += 10_000; // inside 60s cadence
    expect(h.scheduler.shouldRefetch(k)).toEqual({ fetch: false, reason: "not-due" });
    h.scheduler.markRepoMainMoved("o/r");
    expect(h.scheduler.shouldRefetch(k)).toEqual({ fetch: true });
  });
});

describe("gh-scheduler — evict", () => {
  it("removes workspaceId from set; entry preserved if other workspaces remain", () => {
    const h = makeHarness();
    const k = makeKey("o/r", 1);
    h.scheduler.recordFetch(k, makePr(), "ws_a");
    h.scheduler.recordFetch(k, makePr(), "ws_b");
    h.scheduler.evict("ws_a");
    const entry = h.scheduler._entries().get(k)!;
    expect([...entry.workspaceIds]).toEqual(["ws_b"]);
  });

  it("deletes the entry when the last workspace is evicted", () => {
    const h = makeHarness();
    const k = makeKey("o/r", 1);
    h.scheduler.recordFetch(k, makePr(), "ws_a");
    h.scheduler.evict("ws_a");
    expect(h.scheduler._entries().has(k)).toBe(false);
  });

  it("is a no-op for unknown workspaceId", () => {
    const h = makeHarness();
    const k = makeKey("o/r", 1);
    h.scheduler.recordFetch(k, makePr(), "ws_a");
    h.scheduler.evict("ws_unknown");
    expect(h.scheduler._entries().get(k)!.workspaceIds.size).toBe(1);
  });
});

describe("gh-scheduler — hydrate + invalidateNotDue", () => {
  function makeHydrateRow(overrides: Partial<HydrateRow> = {}): HydrateRow {
    return {
      workspaceId: "ws_a",
      repoFullName: "o/r",
      prNumber: 1,
      prState: "open",
      lastHeadSha: "aaa",
      lastHeadShaChangedAt: "2026-05-26T18:00:00.000Z",
      lastChecksGreenAt: null,
      lastMergeStateStatus: null,
      ...overrides,
    };
  }

  it("populates entries from rows; nullable timestamps survive as null", () => {
    const h = makeHarness();
    h.scheduler.hydrate([makeHydrateRow({ lastHeadShaChangedAt: null, lastChecksGreenAt: null })]);
    const entry = h.scheduler._entries().get(makeKey("o/r", 1))!;
    expect(entry.lastHeadShaChangedAt).toBeNull();
    expect(entry.lastChecksConclusion).toBe("unknown");
    expect(entry.state).toBe("open");
  });

  it("classifies merged PRs as non-eligible from the start (no boot-time fetch)", () => {
    const h = makeHarness();
    h.scheduler.hydrate([makeHydrateRow({ prState: "merged" })]);
    expect(h.scheduler.shouldRefetch(makeKey("o/r", 1))).toEqual({ fetch: false, reason: "merged" });
  });

  it("classifies green PRs as 'green' conclusion when lastChecksGreenAt is set", () => {
    const h = makeHarness();
    h.scheduler.hydrate([makeHydrateRow({ lastChecksGreenAt: "2026-05-26T19:00:00.000Z" })]);
    expect(h.scheduler._entries().get(makeKey("o/r", 1))!.lastChecksConclusion).toBe("green");
  });

  it("hydrated non-merged entries are immediately eligible (nextEligibleAt = 0)", () => {
    const h = makeHarness();
    h.scheduler.hydrate([makeHydrateRow()]);
    expect(h.scheduler.shouldRefetch(makeKey("o/r", 1))).toEqual({ fetch: true });
  });

  it("invalidateNotDue clears nextEligibleAt for non-merged entries; merged stays pinned", () => {
    const h = makeHarness();
    const kOpen = makeKey("o/r", 1);
    const kMerged = makeKey("o/r", 2);
    h.scheduler.recordFetch(kOpen, makePr({ number: 1 }), "ws_a");
    h.scheduler.recordFetch(kMerged, makePr({ number: 2, state: "MERGED" }), "ws_b");
    h.clock.t += 10_000; // inside cadence
    expect(h.scheduler.shouldRefetch(kOpen)).toEqual({ fetch: false, reason: "not-due" });
    h.scheduler.invalidateNotDue();
    expect(h.scheduler.shouldRefetch(kOpen)).toEqual({ fetch: true });
    expect(h.scheduler.shouldRefetch(kMerged)).toEqual({ fetch: false, reason: "merged" });
  });
});
