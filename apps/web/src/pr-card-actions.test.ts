// @vitest-environment happy-dom

import type { ProviderHealth, PullRequestSummary, Workspace } from "@citadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { PrCardActionSlot, mergeDisabledReason } from "./pr-card-actions.js";

const roots: Root[] = [];

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
});

describe("mergeDisabledReason", () => {
  it("returns null when every merge gate is open", () => {
    expect(
      mergeDisabledReason({
        allowedMergeStrategies: ["squash"],
        ghProvider: providerHealth({ status: "healthy" }),
        healthQueryError: false,
        healthQueryLoading: false,
        mergeable: "mergeable",
        mergePending: false,
      }),
    ).toBeNull();
  });

  it("explains unavailable GitHub CLI health with provider detail", () => {
    expect(
      mergeDisabledReason({
        allowedMergeStrategies: ["squash"],
        ghProvider: providerHealth({ status: "unavailable", reason: "gh is not installed" }),
        healthQueryError: false,
        healthQueryLoading: false,
        mergeable: "mergeable",
        mergePending: false,
      }),
    ).toBe("GitHub CLI unavailable: gh is not installed");
  });

  it("explains the health loading gate when other merge inputs are ready", () => {
    expect(
      mergeDisabledReason({
        allowedMergeStrategies: ["squash"],
        ghProvider: null,
        healthQueryError: false,
        healthQueryLoading: true,
        mergeable: "mergeable",
        mergePending: false,
      }),
    ).toBe("Checking GitHub CLI availability");
  });

  it("explains mergeability and strategy gates", () => {
    const healthy = providerHealth({ status: "healthy" });
    expect(
      mergeDisabledReason({
        allowedMergeStrategies: ["squash"],
        ghProvider: healthy,
        healthQueryError: false,
        healthQueryLoading: false,
        mergeable: "conflicting",
        mergePending: false,
      }),
    ).toBe("PR has merge conflicts with the base branch");
    expect(
      mergeDisabledReason({
        allowedMergeStrategies: [],
        ghProvider: healthy,
        healthQueryError: false,
        healthQueryLoading: false,
        mergeable: "mergeable",
        mergePending: false,
      }),
    ).toBe("Repository allows no merge strategies via gh");
  });
});

describe("PrCardActionSlot", () => {
  it("puts the disabled merge reason on a hoverable wrapper", () => {
    const container = renderAction({
      mergeable: "unknown",
      allowedMergeStrategies: ["squash"],
    });
    const tooltip = container.querySelector(".pr-card-action-tooltip");
    const button = container.querySelector<HTMLButtonElement>("button.pr-card-btn-merge");

    expect(button?.disabled).toBe(true);
    expect(tooltip?.getAttribute("title")).toBe("PR mergeability is unknown; refresh to recheck");
    expect(button?.getAttribute("title")).toBe("PR mergeability is unknown; refresh to recheck");
  });
});

function renderAction(prOverrides: Partial<PullRequestSummary>) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["provider-health"], { providerHealth: [providerHealth({ status: "healthy" })] });

  flushSync(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PrCardActionSlot, {
          workspace: workspace(),
          pr: pullRequest(prOverrides),
          prTone: "pending",
        }),
      ),
    );
  });

  return rootElement;
}

function providerHealth(overrides: Partial<ProviderHealth>): ProviderHealth {
  return {
    id: "github-gh",
    kind: "pull-request",
    displayName: "GitHub CLI",
    status: "healthy",
    reason: null,
    checkedAt: "2026-05-31T00:00:00.000Z",
    ...overrides,
  };
}

function pullRequest(overrides: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    number: 42,
    title: "Test PR",
    url: "https://example.test/pull/42",
    state: "OPEN",
    draft: false,
    reviewDecision: null,
    checks: [],
    additions: 1,
    deletions: 1,
    reviewers: [],
    commits: [],
    headRefName: "feature/test",
    parentPr: null,
    mergeable: "mergeable",
    allowedMergeStrategies: ["squash"],
    mergeStateStatus: "CLEAN",
    headSha: "abc123",
    ...overrides,
  };
}

function workspace(): Workspace {
  return {
    id: "ws_test",
    repoId: "repo_test",
    name: "Test workspace",
    path: "/tmp/repo",
    branch: "feature/test",
    baseBranch: "main",
    source: "pr",
    kind: "worktree",
    prUrl: "https://example.test/pull/42",
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "review",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    archivedAt: null,
  };
}
