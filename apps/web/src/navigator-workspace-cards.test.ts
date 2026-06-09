// @vitest-environment happy-dom

import type { AgentSession, PullRequestSummary, Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "./api.js";
import { OptimisticRemoveProvider, type StateResponse } from "./app-state.js";
import { aggregateWorkspacePrState } from "./navigator-pr-state.js";
import {
  CheckoutNavCard,
  checkoutBranchLabel,
  checkoutBranchTitle,
  checkoutPrLabel,
  focusTargetAfterCheckoutDrop,
  hasNestedCheckouts,
  isWorkspaceMainCheckout,
  pullRequestForCheckout,
  workspaceAggregateBranchLabel,
  workspaceCheckoutRows,
} from "./navigator-workspace-cards.js";
import { ToastProvider } from "./toast.js";

const ts = "2026-06-01T00:00:00.000Z";
const roots: Root[] = [];

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  queryClient.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("navigator workspace checkout cards", () => {
  it("picks the next checkout target after a checkout drop, falling back to Home", () => {
    expect(focusTargetAfterCheckoutDrop([checkout("co_a"), checkout("co_b"), checkout("co_c")], "co_b")).toBe(
      "checkout:co_c",
    );
    expect(focusTargetAfterCheckoutDrop([checkout("co_a"), checkout("co_b")], "co_b")).toBe("home");
    expect(focusTargetAfterCheckoutDrop([checkout("co_a")], "co_a")).toBe("home");
    expect(focusTargetAfterCheckoutDrop([checkout("co_a")], "co_missing")).toBe("home");
  });

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

  it("lets callers use resolved checkout PR count in aggregate workspace labels", () => {
    expect(
      workspaceAggregateBranchLabel({
        checkouts: [checkout("co_1"), checkout("co_2")],
        sessions: [],
        pullRequest: null,
        prCount: 2,
      }),
    ).toBe("1 repo · 2 worktrees · 2 PRs · 0 sessions");
  });

  it("recognizes only the checkout that mirrors the workspace root as the main checkout row", () => {
    const ws = workspace({ path: "/work/home", rootPath: "/work/home" });
    expect(isWorkspaceMainCheckout(ws, checkout("co_main", { path: "/work/home" }))).toBe(true);
    expect(isWorkspaceMainCheckout(ws, checkout("co_feature", { path: "/work/home/feature" }))).toBe(false);
  });

  it("hides the main checkout row but keeps it in workspace PR aggregation", () => {
    const ws = workspace({ path: "/work/home", rootPath: "/work/home" });
    const main = checkout("co_main", {
      path: "/work/home",
      intendedPr: intendedPr(10),
    });
    const nested = checkout("co_nested", {
      path: "/work/home/nested",
      intendedPr: intendedPr(20),
    });
    const { visibleCheckouts, aggregateCheckouts } = workspaceCheckoutRows(ws, [main, nested]);
    const checkoutPrState = new Map([
      [
        "co_main",
        {
          pullRequest: pr(10, {
            additions: 6,
            deletions: 1,
            mergeable: "conflicting",
            reviewDecision: "CHANGES_REQUESTED",
          }),
          ciRuns: [],
          checkedAt: null,
          cachedAt: null,
        },
      ],
      [
        "co_nested",
        {
          pullRequest: pr(20, { additions: 2, deletions: 2, reviewDecision: "APPROVED" }),
          ciRuns: [],
          checkedAt: null,
          cachedAt: null,
        },
      ],
    ]);

    expect(visibleCheckouts.map((entry) => entry.id)).toEqual(["co_nested"]);
    expect(aggregateCheckouts.map((entry) => entry.id)).toEqual(["co_main", "co_nested"]);

    const aggregate = aggregateWorkspacePrState({
      checkouts: aggregateCheckouts,
      workspacePullRequest: null,
      checkoutPrState,
    });
    expect(aggregate).toEqual({
      prTone: "conflicting",
      approval: "changes",
      additions: 8,
      deletions: 3,
      prCount: 2,
    });
    expect(
      workspaceAggregateBranchLabel({
        checkouts: visibleCheckouts,
        sessions: [],
        pullRequest: null,
        prCount: aggregate.prCount,
      }),
    ).toBe("1 repo · 1 worktree · 2 PRs · 0 sessions");
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

  it("renders no-identity intended PR state as neutral instead of failing", () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      intendedPr: {
        provider: "github",
        number: null,
        url: null,
        headSha: null,
        baseRef: null,
        fetchedAt: "2026-06-05T10:00:00.000Z",
        checksGreen: false,
        mergeStateStatus: "DIRTY",
        hasConflicts: true,
      },
    });
    const container = renderCheckoutCard({
      workspace: ws,
      checkout: co,
      repo: repoFixture({ id: co.repoId, name: "citadel" }),
    });

    const prIcon = container.querySelector(".workspace-card-agent");
    expect(prIcon?.classList.contains("tone-missing")).toBe(true);
    expect(prIcon?.classList.contains("tone-failing")).toBe(false);
    expect(prIcon?.classList.contains("tone-conflicting")).toBe(false);
  });

  it("renders intended PR identity without a PR summary as grey no-PR state", () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      intendedPr: {
        provider: "github",
        number: 12,
        url: "https://x/pr/12",
        headSha: null,
        baseRef: null,
        fetchedAt: "2026-06-05T10:00:00.000Z",
        checksGreen: false,
        mergeStateStatus: "DIRTY",
        hasConflicts: true,
      },
    });
    const container = renderCheckoutCard({
      workspace: ws,
      checkout: co,
      repo: repoFixture({ id: co.repoId, name: "citadel" }),
      pullRequest: null,
    });

    const prIcon = container.querySelector(".workspace-card-agent");
    expect(prIcon?.classList.contains("tone-missing")).toBe(true);
    expect(prIcon?.classList.contains("tone-failing")).toBe(false);
    expect(prIcon?.classList.contains("tone-conflicting")).toBe(false);
    expect(prIcon?.getAttribute("title")).toBe("No PR yet");
  });

  it("shows repo name before branch and keeps the stable git worktree name in hover text", () => {
    const co = checkout("co_api", {
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const repo: Repo = {
      id: "repo_a",
      name: "citadel",
      providerRepositoryKey: "ovdmar/citadel",
      rootPath: "/repo/citadel",
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: "/worktrees",
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: ts,
      updatedAt: ts,
      archivedAt: null,
    };

    expect(checkoutBranchLabel(co, repo)).toBe("ovdmar/citadel · feature/api");
    expect(checkoutBranchTitle(co, repo)).toBe(
      "ovdmar/citadel · feature/api · git worktree: api-stable · /work/home/api-stable",
    );
  });

  it("keeps the checkout lifecycle dot idle after agent attention is acknowledged even when the PR is failing", () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const repo = repoFixture({ id: co.repoId, name: "citadel" });
    const failingPr = pr(12, {
      checks: [
        { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
      ],
    });

    const container = renderCheckoutCard({
      workspace: ws,
      checkout: co,
      repo,
      sessions: [
        session("sess_seen", {
          checkoutId: co.id,
          status: "idle",
          lastStatusAt: "2026-06-05T10:00:00.000Z",
        }),
      ],
      pullRequest: failingPr,
      unseenAttentionSessionIds: new Set(),
    });

    const dot = container.querySelector(".workspace-status-dot");
    expect(dot?.classList.contains("cit-pulse-idle")).toBe(true);
    expect(dot?.classList.contains("cit-pulse-bad")).toBe(false);
    expect(container.querySelector(".workspace-card-agent")?.classList.contains("tone-failing")).toBe(true);
  });

  it("edits the checkout card display title without renaming the git worktree", async () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      name: "api-stable",
      displayName: "API Review",
      path: "/work/home/api-stable",
      branch: "feature/api",
      issue: {
        key: "MS-123",
        title: "Checkout issue",
        url: "https://jira.example/browse/MS-123",
        provider: "jira",
        status: null,
        fetchedAt: null,
      },
    });
    const repo = repoFixture({ id: co.repoId, name: "citadel", providerRepositoryKey: "ovdmar/citadel" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/workspaces/ws_checkout/checkouts/co_api") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return Promise.resolve(
        jsonResponse({ checkout: { ...co, displayName: JSON.parse(String(init?.body)).displayName } }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = renderCheckoutCard({ workspace: ws, checkout: co, repo });
    const branch = Array.from(container.querySelectorAll(".workspace-card-branch")).find(
      (candidate) => candidate.textContent === "ovdmar/citadel · feature/api",
    );
    expect(branch?.getAttribute("title")).toBe(
      "ovdmar/citadel · feature/api · git worktree: api-stable · /work/home/api-stable",
    );

    const title = container.querySelector("strong");
    expect(title?.textContent).toBe("API Review");
    flushSync(() => {
      title?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });

    const input = container.querySelector("input");
    expect(input).toBeTruthy();
    setInputValue(input as HTMLInputElement, "Payments UI");
    flushSync(() => {
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });

    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws_checkout/checkouts/co_api",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ displayName: "Payments UI" }),
      }),
    );
    expect(co.name).toBe("api-stable");
  });

  it("drops an individual checkout through the checkout remove endpoint", async () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const repo = repoFixture({ id: co.repoId, name: "citadel" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/workspaces/ws_checkout/checkouts/co_api") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return Promise.resolve(jsonResponse({ removed: true, dirty: false }, { status: 202 }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onDropFocus = vi.fn();
    const container = renderCheckoutCard({ workspace: ws, checkout: co, repo, onDropFocus });
    const dropButton = container.querySelector('button[aria-label="Drop checkout api-stable"]');
    expect(dropButton).toBeTruthy();
    flushSync(() => {
      dropButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Drop checkout",
    );
    expect(confirm).toBeTruthy();
    flushSync(() => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(onDropFocus).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws_checkout/checkouts/co_api",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("optimistically removes a checkout and restores it with a toast when deletion is blocked", async () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const other = checkout("co_other", { workspaceId: ws.id, name: "other-stable" });
    const repo = repoFixture({ id: co.repoId, name: "citadel" });
    queryClient.setQueryData<StateResponse>(["state"], stateFixture({ workspaces: [ws], checkouts: [co, other] }));

    const deleteRequest: { resolve?: (response: Response) => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== "/api/workspaces/ws_checkout/checkouts/co_api") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return new Promise<Response>((resolve) => {
        deleteRequest.resolve = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = renderCheckoutCard({ workspace: ws, checkout: co, repo });
    const dropButton = container.querySelector('button[aria-label="Drop checkout api-stable"]');
    flushSync(() => {
      dropButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Drop checkout",
    );
    flushSync(() => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => queryClient.getQueryData<StateResponse>(["state"])?.checkouts.length === 1);
    expect(queryClient.getQueryData<StateResponse>(["state"])?.checkouts.map((checkout) => checkout.id)).toEqual([
      "co_other",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const resolveDelete = deleteRequest.resolve;
    if (!resolveDelete) throw new Error("delete request was not started");
    resolveDelete(
      jsonResponse(
        {
          removed: false,
          dirty: true,
          dirtySummary: { files: [], unpushedCommits: [] },
        },
        { status: 409 },
      ),
    );

    await waitFor(() =>
      Boolean(queryClient.getQueryData<StateResponse>(["state"])?.checkouts.some((checkout) => checkout.id === co.id)),
    );
    await waitFor(() =>
      Boolean(
        document
          .querySelector(".cit-toast-message")
          ?.textContent?.includes('Drop "api-stable" failed: uncommitted changes or unpushed commits'),
      ),
    );
  });
});

function renderCheckoutCard(input: {
  workspace: Workspace;
  checkout: WorktreeCheckout;
  repo: Repo;
  sessions?: AgentSession[];
  pullRequest?: PullRequestSummary | null;
  unseenAttentionSessionIds?: ReadonlySet<string>;
  onDropFocus?: () => void;
}) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  flushSync(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          OptimisticRemoveProvider,
          null,
          createElement(
            ToastProvider,
            null,
            createElement(CheckoutNavCard, {
              workspace: input.workspace,
              checkout: input.checkout,
              repo: input.repo,
              sessions: input.sessions ?? [],
              pullRequest: input.pullRequest ?? null,
              active: false,
              onSelect: () => undefined,
              unseenAttentionSessionIds: input.unseenAttentionSessionIds,
              onDropFocus: input.onDropFocus,
            }),
          ),
        ),
      ),
    );
  });
  return rootElement;
}

function stateFixture(input: { workspaces: Workspace[]; checkouts?: WorktreeCheckout[] }): StateResponse {
  return {
    repos: [],
    workspaces: input.workspaces,
    checkouts: input.checkouts ?? [],
    workspacePlans: [],
    workspacePlanDeliveryUnits: [],
    workspacePlanDependencyEdges: [],
    workspaceManagers: [],
    managerActions: [],
    localNotifications: [],
    planDeviations: [],
    sessions: [],
    operations: [],
    activity: [],
    providerHealth: [],
    agentRuntimes: [],
    terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    mcp: { enabled: false, resources: [], tools: [] },
    scheduledAgents: [],
    namespaces: [],
    bootRestore: null,
  };
}

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter missing");
  setter.call(input, value);
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

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

function intendedPr(number: number) {
  return {
    provider: "github" as const,
    number,
    url: `https://x/pr/${number}`,
    headSha: null,
    baseRef: null,
    fetchedAt: null,
    checksGreen: null,
    mergeStateStatus: null,
    hasConflicts: null,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: null,
    name: "Home",
    path: "/work/home",
    rootPath: "/work/home",
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "discovery_inputs",
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

function repoFixture(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_a",
    name: "citadel",
    rootPath: "/repo/citadel",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
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
    terminalBackend: "tmux",
    tmuxSessionName: id,
    tmuxSessionId: id,
    createdAt: ts,
    updatedAt: ts,
    ...overrides,
  };
}

function pr(number: number, overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
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
    ...overrides,
  };
}
