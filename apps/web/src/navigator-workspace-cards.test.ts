// @vitest-environment happy-dom

import type { AgentSession, PullRequestSummary, Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "./api.js";
import {
  CheckoutNavCard,
  checkoutBranchLabel,
  checkoutBranchTitle,
  checkoutPrLabel,
  hasNestedCheckouts,
  pullRequestForCheckout,
  workspaceAggregateBranchLabel,
} from "./navigator-workspace-cards.js";

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

  it("shows repo name before branch and keeps the stable git worktree name in hover text", () => {
    const co = checkout("co_api", {
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const repo: Repo = {
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
    };

    expect(checkoutBranchLabel(co, repo)).toBe("citadel · feature/api");
    expect(checkoutBranchTitle(co, repo)).toBe(
      "citadel · feature/api · git worktree: api-stable · /work/home/api-stable",
    );
  });

  it("edits the checkout card title through the workspace display name without renaming the git worktree", async () => {
    const ws = workspace({ id: "ws_checkout", name: "Readable API" });
    const co = checkout("co_api", {
      workspaceId: ws.id,
      name: "api-stable",
      path: "/work/home/api-stable",
      branch: "feature/api",
    });
    const repo = repoFixture({ id: co.repoId, name: "citadel" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) !== "/api/workspaces/ws_checkout") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return Promise.resolve(jsonResponse({ workspace: { ...ws, name: JSON.parse(String(init?.body)).name } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = renderCheckoutCard({ workspace: ws, checkout: co, repo });
    const branch = Array.from(container.querySelectorAll(".workspace-card-branch")).find(
      (candidate) => candidate.textContent === "citadel · feature/api",
    );
    expect(branch?.getAttribute("title")).toBe(
      "citadel · feature/api · git worktree: api-stable · /work/home/api-stable",
    );

    const title = container.querySelector("strong");
    expect(title?.textContent).toBe("Readable API");
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
      "/api/workspaces/ws_checkout",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ name: "Payments UI" }),
      }),
    );
    expect(co.name).toBe("api-stable");
  });
});

function renderCheckoutCard(input: {
  workspace: Workspace;
  checkout: WorktreeCheckout;
  repo: Repo;
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
        createElement(CheckoutNavCard, {
          workspace: input.workspace,
          checkout: input.checkout,
          repo: input.repo,
          sessions: [],
          pullRequest: null,
          active: false,
          onSelect: () => undefined,
        }),
      ),
    );
  });
  return rootElement;
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
