import type { PullRequestSummary, WorkspaceCockpitSummary, WorkspacePrStateEntry } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePullRequest } from "./navigator-pr-state.js";

function makePr(number: number, state = "OPEN"): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://example.test/pr/${number}`,
    state,
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
