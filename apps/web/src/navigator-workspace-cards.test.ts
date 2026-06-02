import type { AgentSession, PullRequestSummary, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  checkoutPrLabel,
  hasNestedCheckouts,
  pullRequestForCheckout,
  workspaceAggregateBranchLabel,
} from "./navigator-workspace-cards.js";

const ts = "2026-06-01T00:00:00.000Z";

describe("navigator workspace checkout cards", () => {
  it("switches to nested checkout rendering whenever a workspace has checkouts", () => {
    expect(hasNestedCheckouts([])).toBe(false);
    expect(hasNestedCheckouts([checkout("co_1")])).toBe(true);
    expect(hasNestedCheckouts([checkout("co_1"), checkout("co_2")])).toBe(true);
  });

  it("summarizes repos, worktrees, PRs, and live sessions for aggregate workspace rows", () => {
    const checkouts = [
      checkout("co_1", {
        repoId: "repo_a",
        intendedPr: {
          provider: "github",
          number: 12,
          url: "https://x/pr/12",
          headSha: null,
          baseRef: null,
          fetchedAt: null,
          checksGreen: null,
          mergeStateStatus: null,
          hasConflicts: null,
        },
      }),
      checkout("co_2", { repoId: "repo_b" }),
    ];
    expect(
      workspaceAggregateBranchLabel({
        checkouts,
        sessions: [session("sess_1"), session("sess_2", { closedAt: ts })],
        pullRequest: null,
      }),
    ).toBe("2 repos · 2 worktrees · 1 PR · 1 session");
  });

  it("matches a workspace PR summary to a checkout intended PR when possible", () => {
    const co = checkout("co_1", {
      intendedPr: {
        provider: "github",
        number: 12,
        url: "https://x/pr/12",
        headSha: null,
        baseRef: null,
        fetchedAt: null,
        checksGreen: null,
        mergeStateStatus: null,
        hasConflicts: null,
      },
    });
    expect(pullRequestForCheckout(pr(12), co)?.url).toBe("https://x/pr/12");
    expect(pullRequestForCheckout(pr(13), co)).toBeNull();
  });

  it("does not render placeholder PR text for intended PRs without a number", () => {
    const intendedPr = {
      provider: "github" as const,
      number: null,
      url: null,
      headSha: null,
      baseRef: null,
      fetchedAt: null,
      checksGreen: null,
      mergeStateStatus: null,
      hasConflicts: null,
    };
    const co = checkout("co_1", {
      intendedPr,
    });

    expect(checkoutPrLabel(co, null)).toBeNull();
    expect(checkoutPrLabel(checkout("co_2", { intendedPr: { ...intendedPr, number: 12 } }), null)).toBe("PR #12");
    expect(checkoutPrLabel(co, pr(12))).toBe("PR #12");
  });
});

function checkout(id: string, overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id,
    workspaceId: "ws_1",
    repoId: "repo_a",
    name: id,
    path: `/work/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: null,
    gateStatus: "not_started",
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    workspaceId: "ws_1",
    kind: "agent",
    runtimeId: "codex",
    displayName: "Codex",
    status: "running",
    transport: "connected",
    tmuxSessionName: id,
    tmuxSessionId: id,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function pr(number: number): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://x/pr/${number}`,
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
  };
}
