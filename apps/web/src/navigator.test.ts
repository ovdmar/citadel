// @vitest-environment happy-dom

import type {
  AgentRuntime,
  AgentSession,
  PullRequestSummary,
  Repo,
  Workspace,
  WorktreeCheckout,
} from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, createElement, useState } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "./api.js";
import { focusWorkspaceIdAfterDrop } from "./navigator-drop-focus.js";
import type { CheckoutPrStateByWorkspace } from "./navigator-pr-state.js";
import { Navigator, aggregateNavigatorTone } from "./navigator.js";

vi.mock("@tanstack/react-router", () => ({
  Link: (props: { to: string; className?: string; title?: string; children?: ReactNode }) =>
    createElement("a", { href: props.to, className: props.className, title: props.title }, props.children),
  useLocation: () => ({ pathname: "/" }),
}));

const roots: Root[] = [];

beforeEach(() => {
  const storage = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
    },
  });
});

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  window.localStorage?.clear();
  queryClient.clear();
  vi.restoreAllMocks();
});

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Test",
    path: "/tmp/test",
    branch: "feature/test",
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
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...over,
  };
}

function makeAgent(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_a",
    workspaceId: "ws_a",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_a",
    tmuxSessionId: "$1",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...over,
    kind: "agent",
  };
}

function makePr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: "WIP",
    url: "https://example/pr/1",
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
    ...over,
  };
}

describe("aggregateNavigatorTone", () => {
  it("never-started when no workspaces are passed", () => {
    expect(aggregateNavigatorTone([], [], undefined)).toBe("never-started");
  });

  it("never-started when workspaces exist but have no agent sessions", () => {
    expect(aggregateNavigatorTone([makeWorkspace({ id: "w1" })], [], undefined)).toBe("never-started");
  });

  it("running when one workspace has a running agent and no PR fold", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" })],
        [makeAgent({ workspaceId: "w1", status: "running" })],
        undefined,
      ),
    ).toBe("running");
  });

  it("running when a nested checkout has a running agent", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "ws_home" })],
        [makeAgent({ id: "sess_checkout", workspaceId: "ws_home", checkoutId: "co_api", status: "running" })],
        undefined,
        [makeCheckout({ id: "co_api", workspaceId: "ws_home" })],
      ),
    ).toBe("running");
  });

  it("done when every workspace's agents finished and no PR overrides", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        undefined,
      ),
    ).toBe("done");
  });

  it("running wins over done across workspaces", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "running" }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        undefined,
      ),
    ).toBe("running");
  });

  it("unseen attention short-circuits over both running and done", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" }), makeWorkspace({ id: "w3" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "running" }),
          makeAgent({ id: "c", workspaceId: "w3", status: "failed" }),
        ],
        undefined,
        [],
        undefined,
        new Set(["c"]),
      ),
    ).toBe("attention");
  });

  it("acknowledged attention no longer short-circuits running workspaces", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "running" }),
          makeAgent({ id: "b", workspaceId: "w2", status: "failed" }),
        ],
        undefined,
      ),
    ).toBe("running");
  });

  it("PR with a failing check on one workspace escalates the global tone to attention", () => {
    const map = new Map<string, PullRequestSummary | null>();
    map.set(
      "w1",
      makePr({
        checks: [
          { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
        ],
      }),
    );
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "running" }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        map,
      ),
    ).toBe("attention");
  });

  it("PR conflict on one workspace escalates the global tone to attention", () => {
    const map = new Map<string, PullRequestSummary | null>();
    map.set("w1", makePr({ mergeable: "conflicting" }));
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        map,
      ),
    ).toBe("attention");
  });

  it("missing workspacePullRequests is treated as 'no fold' (degrades safely)", () => {
    // Same inputs as the running+passing-CI case, but no PR map at all → still running.
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" })],
        [makeAgent({ workspaceId: "w1", status: "running" })],
        undefined,
      ),
    ).toBe("running");
  });
});

describe("Navigator checkout aggregation", () => {
  it("picks the next workspace after a drop, falling back to the nearest previous workspace", () => {
    expect(focusWorkspaceIdAfterDrop(["ws_a", "ws_b", "ws_c"], "ws_b")).toBe("ws_c");
    expect(focusWorkspaceIdAfterDrop(["ws_a", "ws_b"], "ws_b")).toBe("ws_a");
    expect(focusWorkspaceIdAfterDrop(["ws_a"], "ws_a")).toBeNull();
    expect(focusWorkspaceIdAfterDrop(["ws_a", "ws_a", "ws_b"], "ws_a")).toBe("ws_b");
    expect(focusWorkspaceIdAfterDrop(["ws_a"], "ws_missing")).toBeNull();
  });

  it("autoselects a newly attached worktree after creation", async () => {
    const repo = makeRepo({ id: "repo_a" });
    const workspace = makeWorkspace({
      id: "ws_home",
      repoId: null,
      name: "Feature Home",
      path: "/work/feature-home",
      rootPath: "/work/feature-home",
      branch: "home",
      kind: "root",
      mode: "structured",
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== "/api/workspaces/ws_home/checkouts") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return Promise.resolve(jsonResponse({ workspaceId: "ws_home", checkoutId: "co_new" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPickTarget = vi.fn();
    const onPickWorkspaceId = vi.fn();

    const container = renderNavigator({
      repos: [repo],
      workspaces: [workspace],
      onPickTarget,
      onPickWorkspaceId,
    });
    await clickButtonByLabel(container, "Add worktree to Feature Home");
    expect(checkboxes(container).map((checkbox) => checkbox.checked)).toEqual([false]);
    clickCheckbox(container);
    setInputByPlaceholder(container, "Optional", "Payments UI");
    await clickButton(container, "Add worktree");

    await waitFor(() =>
      onPickTarget.mock.calls.some(
        ([workspaceId, targetKey]) => workspaceId === "ws_home" && targetKey === "checkout:co_new",
      ),
    );
    expect(onPickWorkspaceId).not.toHaveBeenCalled();
  });

  it("renders hidden main-only checkout PR state on the parent workspace row", () => {
    const workspace = makeWorkspace({
      id: "ws_main",
      repoId: null,
      name: "Home",
      path: "/work/home",
      rootPath: "/work/home",
      branch: "home",
      kind: "root",
      mode: "structured",
    });
    const checkout = makeCheckout({
      id: "co_main",
      workspaceId: workspace.id,
      path: workspace.path,
      intendedPr: intendedPr(17),
    });
    const checkoutPrByWorkspaceId: CheckoutPrStateByWorkspace = new Map([
      [
        workspace.id,
        new Map([
          [
            checkout.id,
            {
              pullRequest: makePr({
                number: 17,
                url: "https://example/pr/17",
                additions: 25,
                deletions: 9,
                mergeable: "conflicting",
                reviewDecision: "CHANGES_REQUESTED",
              }),
              ciRuns: [],
              checkedAt: null,
              cachedAt: null,
            },
          ],
        ]),
      ],
    ]);

    const container = renderNavigator({
      workspaces: [workspace],
      checkouts: [checkout],
      prByWorkspaceId: new Map([[workspace.id, null]]),
      checkoutPrByWorkspaceId,
    });

    expect(container.querySelector(".nav-checkout-card")).toBeNull();
    expect(container.querySelector(".workspace-card-branch")).toBeNull();
    expect(container.querySelector(".workspace-card-agent")?.className).toContain("tone-conflicting");
    expect(container.querySelector(".workspace-card-diff")?.textContent).toBe("+25-9");
    expect(container.querySelector(".approval-pill")?.getAttribute("title")).toBe("Approval: changes");
  });

  it("renders running checkout agents as orange pulses on parent and worktree cards", () => {
    const workspace = makeWorkspace({
      id: "ws_home",
      repoId: null,
      name: "Home",
      path: "/work/home",
      rootPath: "/work/home",
      branch: "home",
      kind: "root",
      mode: "structured",
    });
    const checkout = makeCheckout({
      id: "co_api",
      workspaceId: workspace.id,
      name: "api",
      path: "/work/home/api",
      branch: "feature/api",
    });
    const container = renderNavigator({
      workspaces: [workspace],
      checkouts: [checkout],
      sessions: [makeAgent({ id: "sess_api", workspaceId: workspace.id, checkoutId: checkout.id, status: "running" })],
    });

    const dots = Array.from(container.querySelectorAll(".workspace-status-dot"));
    expect(dots).toHaveLength(2);
    expect(dots.every((dot) => dot.classList.contains("cit-pulse-run"))).toBe(true);
    expect(dots.some((dot) => dot.classList.contains("cit-pulse-idle"))).toBe(false);
  });

  it("hides a shown main repo workspace through the repo visibility flag", async () => {
    const repo = makeRepo({ id: "repo_a", showMainWorkspace: true });
    const workspace = makeWorkspace({
      id: "ws_root",
      repoId: repo.id,
      name: "main",
      path: "/repo/citadel",
      rootPath: "/repo/citadel",
      branch: "main",
      kind: "root",
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input) !== "/api/repos/repo_a") {
        return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
      }
      return Promise.resolve(jsonResponse({ repo: { ...repo, showMainWorkspace: false } }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = renderNavigator({ repos: [repo], workspaces: [workspace] });
    const hide = container.querySelector('button[aria-label="Hide main from navigation"]');
    expect(hide).toBeTruthy();
    flushSync(() => {
      hide?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => fetchMock.mock.calls.length === 1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/repos/repo_a",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ showMainWorkspace: false }),
      }),
    );
  });

  it("focuses the next rendered workspace when a workspace drop starts", async () => {
    const first = makeWorkspace({ id: "ws_first", name: "First" });
    const middle = makeWorkspace({ id: "ws_middle", name: "Middle" });
    const last = makeWorkspace({ id: "ws_last", name: "Last" });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/workspaces/ws_middle/removal-check") {
        return Promise.resolve(jsonResponse({ removable: true, dirty: false, reason: "ok" }));
      }
      if (String(input) === "/api/workspaces/ws_middle" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ removed: true, archived: false, dirty: false }, { status: 202 }));
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    const onPickTarget = vi.fn();

    const container = renderNavigator({
      workspaces: [first, middle, last],
      onPickTarget,
    });
    await clickButtonByLabel(container, "Drop workspace Middle");

    const confirm = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Drop workspace",
    );
    await waitFor(() => Boolean(confirm && !(confirm as HTMLButtonElement).disabled));
    flushSync(() => {
      confirm?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => fetchMock.mock.calls.some(([input]) => String(input) === "/api/workspaces/ws_middle"));
    expect(onPickTarget).toHaveBeenCalledWith("ws_last", "home");
  });
});

function renderNavigator(overrides: {
  repos?: Repo[];
  workspaces?: Workspace[];
  checkouts?: WorktreeCheckout[];
  sessions?: AgentSession[];
  prByWorkspaceId?: Map<string, PullRequestSummary | null>;
  checkoutPrByWorkspaceId?: CheckoutPrStateByWorkspace;
  onPickTarget?: (workspaceId: string, targetKey: string) => void;
  onPickWorkspaceId?: (workspaceId: string) => void;
}) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);
  flushSync(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(NavigatorHarness, { overrides })),
    );
  });
  return document.body;
}

function NavigatorHarness(props: {
  overrides: {
    repos?: Repo[];
    workspaces?: Workspace[];
    checkouts?: WorktreeCheckout[];
    sessions?: AgentSession[];
    prByWorkspaceId?: Map<string, PullRequestSummary | null>;
    checkoutPrByWorkspaceId?: CheckoutPrStateByWorkspace;
    onPickTarget?: (workspaceId: string, targetKey: string) => void;
    onPickWorkspaceId?: (workspaceId: string) => void;
  };
}) {
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const overrides = props.overrides;
  return createElement(Navigator, {
    repos: overrides.repos ?? [],
    workspaces: overrides.workspaces ?? [],
    checkouts: overrides.checkouts ?? [],
    sessions: overrides.sessions ?? [],
    operations: [],
    prByWorkspaceId: overrides.prByWorkspaceId ?? new Map(),
    checkoutPrByWorkspaceId: overrides.checkoutPrByWorkspaceId ?? new Map(),
    activeWorkspaceId: "",
    activeTargetKey: "home",
    runtimes: [makeRuntime()],
    namespaces: [],
    createWorkspaceOpen,
    onOpenCreateWorkspace: () => setCreateWorkspaceOpen(true),
    onCloseCreateWorkspace: () => setCreateWorkspaceOpen(false),
    onCollapse: () => undefined,
    onPickWorkspace: () => undefined,
    onPickWorkspaceId: overrides.onPickWorkspaceId ?? (() => undefined),
    onPickTarget: overrides.onPickTarget ?? (() => undefined),
  });
}

async function clickButton(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  flushSync(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushPromises();
}

async function clickButtonByLabel(container: HTMLElement, label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  expect(button).toBeTruthy();
  flushSync(() => {
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushPromises();
}

function clickCheckbox(container: HTMLElement, index = 0) {
  const input = checkboxes(container)[index];
  expect(input).toBeTruthy();
  flushSync(() => {
    input?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function checkboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
}

function setInputByPlaceholder(container: HTMLElement, placeholder: string, value: string) {
  const input = Array.from(container.querySelectorAll("input")).find(
    (candidate) => candidate.getAttribute("placeholder") === placeholder,
  );
  expect(input).toBeTruthy();
  setInputValue(input as HTMLInputElement, value);
  flushSync(() => {
    input?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("input value setter missing");
  setter.call(input, value);
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(predicate()).toBe(true);
}

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_a",
    name: "citadel",
    rootPath: "/repo/citadel",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/worktrees",
    providerRepositoryKey: "ovdmar/citadel",
    showMainWorkspace: false,
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeCheckout(overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id: "co_a",
    workspaceId: "ws_a",
    repoId: "repo_a",
    name: "main",
    path: "/tmp/test",
    branch: "feature/test",
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: null,
    gateStatus: "not_started",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function intendedPr(number: number) {
  return {
    provider: "github" as const,
    number,
    url: `https://example/pr/${number}`,
    headSha: null,
    baseRef: null,
    fetchedAt: null,
    checksGreen: null,
    mergeStateStatus: null,
    hasConflicts: null,
  };
}

function makeRuntime(): AgentRuntime {
  return {
    id: "codex",
    displayName: "Codex",
    command: "codex",
    args: [],
    health: "healthy",
    healthReason: null,
    capabilities: {
      supportsPrompt: true,
      supportsResume: true,
      supportsModelSelection: true,
      supportsTranscript: true,
      supportsStatusDetection: true,
      supportsNonInteractiveGoal: true,
      supportsShell: true,
      supportsUsage: false,
      supportsTui: true,
    },
  };
}
