import type {
  PullRequestSummary,
  WorkspaceCockpitSummary,
  WorkspacePrStateEntry,
  WorktreeCheckout,
} from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  aggregateWorkspacePrState,
  checkoutPrStateMap,
  checkoutPullRequest,
  resolveWorkspacePullRequest,
} from "./navigator-pr-state.js";

function makePr(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://example.test/pr/${number}`,
    state: "OPEN",
    draft: false,
    reviewDecision: null,
    checks: [],
    additions: null,
    deletions: null,
    reviewers: [],
    commits: [],
    headRefName: null,
    parentPr: null,
    mergeable: "unknown",
    allowedMergeStrategies: [],
    mergeStateStatus: null,
    headSha: null,
    ...overrides,
  };
}

function makeActiveSummary(workspaceId: string, pr: PullRequestSummary | null): WorkspaceCockpitSummary {
  return {
    workspaceId,
    readiness: { sectionStatus: "ready", reasons: [], nextAction: null },
    git: null,
    versionControl: {
      providerId: "github-gh",
      status: "healthy",
      reason: null,
      defaultBranch: "main",
      currentBranch: "main",
      remotes: [],
      pullRequest: pr,
      checkedAt: new Date().toISOString(),
    },
    ci: { providerId: "github-gh", status: "healthy", reason: null, runs: [], checkedAt: new Date().toISOString() },
    issueTracker: null,
    apps: [],
  } as unknown as WorkspaceCockpitSummary;
}

function makeEntry(pr: PullRequestSummary | null): WorkspacePrStateEntry {
  return { pullRequest: pr, ciRuns: [], checkedAt: null, cachedAt: null };
}

describe("resolveWorkspacePullRequest", () => {
  it("prefers activeSummary's PR for the active workspace", () => {
    const activePr = makePr(101);
    const result = resolveWorkspacePullRequest({
      workspaceId: "active",
      activeSummary: makeActiveSummary("active", activePr),
      workspacesPrState: { active: makeEntry(makePr(200)) },
    });
    expect(result?.number).toBe(101);
  });

  it("uses workspacesPrState for non-active workspaces", () => {
    const result = resolveWorkspacePullRequest({
      workspaceId: "non-active",
      activeSummary: makeActiveSummary("active", makePr(101)),
      workspacesPrState: { "non-active": makeEntry(makePr(200)) },
    });
    expect(result?.number).toBe(200);
  });

  it("falls back to null when no cached state exists for a non-active workspace", () => {
    const result = resolveWorkspacePullRequest({
      workspaceId: "non-active",
      activeSummary: makeActiveSummary("active", makePr(101)),
      workspacesPrState: {},
    });
    expect(result).toBeNull();
  });

  it("falls back to null when active workspace has no PR even if pr-state holds one", () => {
    const result = resolveWorkspacePullRequest({
      workspaceId: "active",
      activeSummary: makeActiveSummary("active", null),
      workspacesPrState: { active: makeEntry(makePr(200)) },
    });
    // Active wins; null is correct here even though pr-state has a stale entry.
    expect(result).toBeNull();
  });

  it("handles a null/undefined activeSummary gracefully", () => {
    const result = resolveWorkspacePullRequest({
      workspaceId: "ws",
      activeSummary: null,
      workspacesPrState: { ws: makeEntry(makePr(42)) },
    });
    expect(result?.number).toBe(42);
  });
});

describe("checkout PR aggregation", () => {
  it("uses checkout-specific PR state before workspace-level fallback", () => {
    const co = checkout("co_1", { intendedPr: intendedPr(12) });
    const checkoutState = new Map([["co_1", makeEntry(makePr(12, { title: "checkout" }))]]);
    expect(
      checkoutPullRequest({
        checkout: co,
        workspacePullRequest: makePr(12, { title: "workspace" }),
        checkoutPrState: checkoutState,
      })?.title,
    ).toBe("checkout");
  });

  it("aggregates nested PR tone by attention priority and totals checkout diffs", () => {
    const checkouts = [
      checkout("co_ok", { intendedPr: intendedPr(1) }),
      checkout("co_conflict", { intendedPr: intendedPr(2) }),
    ];
    const checkoutState = checkoutPrStateMap({
      ws: {
        co_ok: makeEntry(makePr(1, { additions: 3, deletions: 4, reviewDecision: "APPROVED" })),
        co_conflict: makeEntry(
          makePr(2, { additions: 10, deletions: 2, mergeable: "conflicting", reviewDecision: "APPROVED" }),
        ),
      },
    }).get("ws");

    expect(
      aggregateWorkspacePrState({ checkouts, workspacePullRequest: null, checkoutPrState: checkoutState }),
    ).toEqual({
      prTone: "conflicting",
      approval: "approved",
      additions: 13,
      deletions: 6,
      prCount: 2,
    });
  });

  it("keeps approval pending until every expected nested PR is approved", () => {
    const checkouts = [
      checkout("co_approved", { intendedPr: intendedPr(1) }),
      checkout("co_pending", { intendedPr: intendedPr(2) }),
    ];
    const checkoutState = new Map([["co_approved", makeEntry(makePr(1, { reviewDecision: "APPROVED" }))]]);

    expect(
      aggregateWorkspacePrState({ checkouts, workspacePullRequest: null, checkoutPrState: checkoutState }).approval,
    ).toBe("pending");
  });

  it("single-worktree aggregate diff equals the checkout PR diff", () => {
    const checkouts = [checkout("co_only", { intendedPr: intendedPr(7) })];
    const checkoutState = new Map([
      ["co_only", makeEntry(makePr(7, { additions: 25, deletions: 9, reviewDecision: "APPROVED" }))],
    ]);

    expect(
      aggregateWorkspacePrState({ checkouts, workspacePullRequest: null, checkoutPrState: checkoutState }),
    ).toMatchObject({
      additions: 25,
      deletions: 9,
      approval: "approved",
    });
  });
});

function checkout(id: string, overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id,
    workspaceId: "ws",
    repoId: "repo",
    name: id,
    path: `/work/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: null,
    gateStatus: "not_started",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function intendedPr(number: number) {
  return {
    provider: "github" as const,
    number,
    url: `https://example.test/pr/${number}`,
    headSha: null,
    baseRef: null,
    fetchedAt: null,
    checksGreen: null,
    mergeStateStatus: null,
    hasConflicts: null,
  };
}
