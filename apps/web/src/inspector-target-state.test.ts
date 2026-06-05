import type { PullRequestSummary, Repo, Workspace, WorkspacePrStateEntry, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { resolveInspectorTargetState } from "./inspector-target-state.js";

describe("resolveInspectorTargetState", () => {
  it("uses workspace PR state for workspace Home targets", () => {
    const pr = pullRequest(1);
    const state = resolveInspectorTargetState({
      workspace: workspace({ repoId: "repo_web", branch: "feature/home", baseBranch: "main" }),
      repos: [repo("repo_web")],
      checkouts: [],
      activeCheckoutId: null,
      workspacePullRequest: pr,
      workspaceCheckedAt: "2026-06-05T01:00:00.000Z",
      checkoutPrState: null,
    });

    expect(state).toMatchObject({
      checkout: null,
      repo: { id: "repo_web" },
      pullRequest: { number: 1 },
      checkedAt: "2026-06-05T01:00:00.000Z",
      branch: "feature/home",
      baseBranch: "main",
    });
  });

  it("uses active checkout repo/path PR state before workspace fallback", () => {
    const checkout = worktreeCheckout({
      id: "co_api",
      repoId: "repo_api",
      branch: "feature/api",
      baseBranch: "develop",
      intendedPr: intendedPr(2),
    });
    const state = resolveInspectorTargetState({
      workspace: workspace({ repoId: null, branch: "home", baseBranch: "main" }),
      repos: [repo("repo_web"), repo("repo_api")],
      checkouts: [checkout],
      activeCheckoutId: "co_api",
      workspacePullRequest: pullRequest(1),
      workspaceCheckedAt: "2026-06-05T01:00:00.000Z",
      checkoutPrState: new Map([
        [
          "co_api",
          {
            pullRequest: pullRequest(2),
            ciRuns: [],
            checkedAt: "2026-06-05T02:00:00.000Z",
            cachedAt: "2026-06-05T01:59:00.000Z",
          },
        ],
      ]),
    });

    expect(state).toMatchObject({
      checkout: { id: "co_api" },
      repo: { id: "repo_api" },
      pullRequest: { number: 2 },
      checkedAt: "2026-06-05T02:00:00.000Z",
      branch: "feature/api",
      baseBranch: "develop",
    });
  });

  it("uses matching workspace PR state when the checkout cache is present but still empty", () => {
    const checkout = worktreeCheckout({
      id: "co_api",
      repoId: "repo_api",
      branch: "feature/api",
      baseBranch: "develop",
      intendedPr: intendedPr(2),
    });
    const state = resolveInspectorTargetState({
      workspace: workspace({ repoId: null, branch: "home", baseBranch: "main" }),
      repos: [repo("repo_web"), repo("repo_api")],
      checkouts: [checkout],
      activeCheckoutId: "co_api",
      workspacePullRequest: pullRequest(2),
      workspaceCheckedAt: "2026-06-05T01:00:00.000Z",
      checkoutPrState: new Map([
        [
          "co_api",
          {
            pullRequest: null,
            ciRuns: [],
            checkedAt: "2026-06-05T02:00:00.000Z",
            cachedAt: "2026-06-05T01:59:00.000Z",
          },
        ],
      ]),
    });

    expect(state).toMatchObject({
      checkout: { id: "co_api" },
      repo: { id: "repo_api" },
      pullRequest: { number: 2 },
      checkedAt: "2026-06-05T02:00:00.000Z",
      branch: "feature/api",
      baseBranch: "develop",
    });
  });
});

function repo(id: string): Repo {
  return {
    id,
    name: id,
    rootPath: `/repos/${id}`,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: `/worktrees/${id}`,
    providerRepositoryKey: `owner/${id}`,
    showMainWorkspace: false,
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    archivedAt: null,
  };
}

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: "ws_structured",
    repoId: null,
    name: "Structured",
    path: "/work/structured",
    rootPath: "/work/structured",
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
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function worktreeCheckout(overrides: Partial<WorktreeCheckout>): WorktreeCheckout {
  return {
    id: "co_api",
    workspaceId: "ws_structured",
    repoId: "repo_api",
    name: "api",
    displayName: null,
    path: "/work/structured/api",
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function pullRequest(number: number): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    url: `https://example.test/pull/${number}`,
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

function intendedPr(number: number): WorktreeCheckout["intendedPr"] {
  return {
    provider: "github",
    number,
    url: `https://example.test/pull/${number}`,
    headSha: null,
    baseRef: null,
    fetchedAt: null,
    checksGreen: null,
    mergeStateStatus: null,
    hasConflicts: null,
  };
}
