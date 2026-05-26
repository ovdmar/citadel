import type { PullRequestSummary, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import type { WorkspaceCockpitSummaryBatchResponse } from "@citadel/contracts/pr-routes";
import { describe, expect, it } from "vitest";
import {
  applyStickyUpdates,
  filterPollableWorkspaceIds,
  nextPollInterval,
  prMapFromSummaries,
} from "./cockpit-tools.js";

const workspace = (overrides: Partial<Workspace>): Workspace =>
  ({
    id: "ws_test",
    repoId: "repo_test",
    name: "Test",
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
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    archivedAt: null,
    ...overrides,
  }) as Workspace;

const makePr = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 42,
  title: "Test",
  url: "https://x.test/pr/42",
  state: "OPEN",
  draft: false,
  reviewDecision: null,
  checks: [],
  additions: 12,
  deletions: 3,
  reviewers: [],
  commits: [],
  headRefName: "feature",
  parentPr: null,
  mergeable: "unknown",
  allowedMergeStrategies: [],
  ...overrides,
});

const makeSummary = (
  id: string,
  status: "healthy" | "degraded",
  pr: PullRequestSummary | null = null,
): WorkspaceCockpitSummary =>
  ({
    workspaceId: id,
    readiness: { tone: "idle", label: "ready" },
    git: { clean: true, ahead: 0, behind: 0 },
    versionControl: {
      providerId: "github-gh",
      status,
      reason: status === "degraded" ? "gh timed out" : null,
      defaultBranch: "main",
      currentBranch: "feature",
      remotes: ["origin"],
      pullRequest: pr,
      checkedAt: new Date().toISOString(),
    },
    ci: { providerId: "github-gh", status: "healthy", reason: null, runs: [], checkedAt: new Date().toISOString() },
    issueTracker: null,
    apps: { applications: [] },
  }) as unknown as WorkspaceCockpitSummary;

describe("filterPollableWorkspaceIds", () => {
  it("drops root-kind workspaces so the daemon doesn't waste gh spawns on them", () => {
    expect(
      filterPollableWorkspaceIds([
        workspace({ id: "ws_a", kind: "worktree" }),
        workspace({ id: "ws_root", kind: "root" }),
        workspace({ id: "ws_b", kind: "worktree" }),
      ]),
    ).toEqual(["ws_a", "ws_b"]);
  });

  it("returns an empty list when every workspace is root — react-query then disables the poll", () => {
    expect(
      filterPollableWorkspaceIds([workspace({ id: "ws_r1", kind: "root" }), workspace({ id: "ws_r2", kind: "root" })]),
    ).toEqual([]);
  });
});

describe("nextPollInterval", () => {
  it("polls every 30s when the tab is visible", () => {
    expect(nextPollInterval("visible")).toBe(30_000);
  });

  it("returns false (pause) when the tab is hidden so daemon spawn pressure goes to zero", () => {
    expect(nextPollInterval("hidden")).toBe(false);
  });

  it("falls back to polling when visibilityState is undefined (non-browser host)", () => {
    expect(nextPollInterval(undefined)).toBe(30_000);
  });
});

describe("applyStickyUpdates", () => {
  it("writes healthy summaries into the cache", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    const summary = makeSummary("ws_a", "healthy", makePr({ number: 7 }));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("preserves the previous entry when a refetch returns a degraded summary (transient gh failure)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "degraded", null) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    // Sticky cache must NOT drop the known-good PR just because gh blipped.
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("preserves the previous entry on non-authoritative ok:false reasons", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: false, reason: "summary_failed" }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest?.number).toBe(7);
  });

  it("clears the entry on authoritative ok:false reasons", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [
        { workspaceId: "ws_a", ok: false, reason: "no-remote" },
        { workspaceId: "ws_b", ok: false, reason: "root-workspace" },
        { workspaceId: "ws_c", ok: false, reason: "workspace_not_found" },
      ],
    };
    cache.set("ws_b", makeSummary("ws_b", "healthy", makePr()));
    cache.set("ws_c", makeSummary("ws_c", "healthy", makePr()));
    applyStickyUpdates(cache, new Set(["ws_a", "ws_b", "ws_c"]), batch);
    expect(cache.has("ws_a")).toBe(false);
    expect(cache.has("ws_b")).toBe(false);
    expect(cache.has("ws_c")).toBe(false);
  });

  it("overwrites with a healthy null pullRequest (PR closed/merged is authoritative)", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ number: 7 })));
    const batch: WorkspaceCockpitSummaryBatchResponse = {
      summaries: [{ workspaceId: "ws_a", ok: true, summary: makeSummary("ws_a", "healthy", null) }],
    };
    applyStickyUpdates(cache, new Set(["ws_a"]), batch);
    expect(cache.get("ws_a")?.versionControl.pullRequest).toBeNull();
  });

  it("prunes entries for workspaces that no longer exist", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_gone", makeSummary("ws_gone", "healthy", makePr()));
    cache.set("ws_kept", makeSummary("ws_kept", "healthy", makePr()));
    applyStickyUpdates(cache, new Set(["ws_kept"]), undefined);
    expect(cache.has("ws_gone")).toBe(false);
    expect(cache.has("ws_kept")).toBe(true);
  });
});

describe("prMapFromSummaries", () => {
  it("derives a PR map preserving additions/deletions for the navbar diff display", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_a", makeSummary("ws_a", "healthy", makePr({ additions: 88, deletions: 11 })));
    const map = prMapFromSummaries(cache);
    expect(map.get("ws_a")?.additions).toBe(88);
    expect(map.get("ws_a")?.deletions).toBe(11);
  });

  it("returns null for workspaces whose summary has no PR", () => {
    const cache = new Map<string, WorkspaceCockpitSummary>();
    cache.set("ws_nopr", makeSummary("ws_nopr", "healthy", null));
    expect(prMapFromSummaries(cache).get("ws_nopr")).toBeNull();
  });
});
