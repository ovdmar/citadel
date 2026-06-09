// @vitest-environment happy-dom

import type { Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing__ } from "./add-repo-modal.js";
import { queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { CreateWorkspaceModal, resolveCreateWorkspaceContext } from "./modals.js";
import { ToastProvider } from "./toast.js";

const { pathCompletionSelection } = __testing__;
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

describe("add repo path completion", () => {
  it("selects git repositories instead of drilling into them", () => {
    expect(pathCompletionSelection({ path: "/home/me/project", isGit: true })).toEqual({
      value: "/home/me/project",
      keepOpen: false,
    });
  });

  it("keeps navigating through ordinary directories", () => {
    expect(pathCompletionSelection({ path: "/home/me/projects", isGit: false })).toEqual({
      value: "/home/me/projects/",
      keepOpen: true,
    });
  });
});

describe("resolveCreateWorkspaceContext", () => {
  it("creates workspace Homes by default", () => {
    expect(resolveCreateWorkspaceContext(undefined, ["workspace"])).toBe("workspace-home");
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["namespace", "workspace"])).toBe("workspace-home");
  });

  it("keeps repository grouping in workspace Home creation mode", () => {
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo"])).toBe("workspace-home");
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo", "status"])).toBe("workspace-home");
  });

  it("uses attach mode when opened from a workspace Home", () => {
    expect(
      resolveCreateWorkspaceContext({ kind: "attach-worktree", workspaceId: "ws_1", workspaceName: "Home" }, ["repo"]),
    ).toBe("attach-worktree");
  });
});

describe("CreateWorkspaceModal", () => {
  it("does not close the form before workspace creation settles", async () => {
    const pendingHome: { resolve?: (value: Response) => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspaces/home") {
        return new Promise<Response>((resolve) => {
          pendingHome.resolve = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onClose = vi.fn();
    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({ onClose, onCreated, grouping: ["workspace"] });

    setInputByPlaceholder(container, "workspace-name", "Feature Home");
    await clickButton(container, "Create workspace");

    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/workspaces/home")).toBe(true);

    if (!pendingHome.resolve) throw new Error("workspace Home request was not started");
    pendingHome.resolve(jsonResponse({ workspaceId: "ws_new" }));
    await waitFor(() => onCreated.mock.calls.some(([workspaceId]) => workspaceId === "ws_new"));

    expect(onCreated).toHaveBeenCalledWith("ws_new");
  });

  it("creates selected initial worktrees with daemon-generated defaults", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === "/api/workspaces/home") return Promise.resolve(jsonResponse({ workspaceId: "ws_new" }));
      if (url === "/api/workspaces/ws_new/checkouts")
        return Promise.resolve(jsonResponse({ workspaceId: "ws_new", checkoutId: "co_new" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({ grouping: ["repo"], repos: [repo()], onCreated });

    setInputByPlaceholder(container, "workspace-name", "Feature Home");
    expect(checkboxes(container).map((checkbox) => checkbox.checked)).toEqual([false]);
    clickCheckbox(container);
    await clickButton(container, "Create workspace and worktrees");
    await waitFor(() => fetchMock.mock.calls.some(([input]) => String(input) === "/api/workspaces/ws_new/checkouts"));

    const checkoutCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/workspaces/ws_new/checkouts");
    expect(checkoutCall).toBeTruthy();
    const body = JSON.parse(String(checkoutCall?.[1]?.body));
    expect(body).toMatchObject({ repoId: "repo_1", source: "default_branch" });
    expect(body).not.toHaveProperty("name");
    expect(body).not.toHaveProperty("branch");
    await waitFor(() =>
      onCreated.mock.calls.some(
        ([workspaceId, targetKey]) => workspaceId === "ws_new" && targetKey === "checkout:co_new",
      ),
    );
    expect(onCreated).toHaveBeenCalledWith("ws_new", "checkout:co_new");
  });

  it("adds a worktree without launching an agent when opened from workspace Home", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspaces/ws_home/checkouts")
        return Promise.resolve(jsonResponse({ workspaceId: "ws_home", checkoutId: "co_new" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({
      repos: [repo()],
      onCreated,
      intent: { kind: "attach-worktree", workspaceId: "ws_home", workspaceName: "Feature Home" },
    });

    expect(checkboxes(container).map((checkbox) => checkbox.checked)).toEqual([false]);
    expect(buttonByText(container, "Add worktree").disabled).toBe(true);
    clickCheckbox(container);
    setInputByPlaceholder(container, "Optional", "Payments UI");
    await clickButton(container, "Add worktree");
    await waitFor(() =>
      onCreated.mock.calls.some(
        ([workspaceId, targetKey]) => workspaceId === "ws_home" && targetKey === "checkout:co_new",
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspaces/ws_home/checkouts",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repoId: "repo_1",
          source: "default_branch",
          name: "Payments UI",
          displayName: "Payments UI",
        }),
      }),
    );
    expect(onCreated).toHaveBeenCalledWith("ws_home", "checkout:co_new");
  });

  it("adds and selects a pending worktree before checkout creation settles", async () => {
    const pendingCheckout: { resolve?: (value: Response) => void } = {};
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspaces/ws_home/checkouts") {
        return new Promise<Response>((resolve) => {
          pendingCheckout.resolve = resolve;
        });
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    queryClient.setQueryData<StateResponse>(["state"], stateFixture({ repos: [repo()], workspaces: [workspace()] }));

    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({
      repos: [repo()],
      onCreated,
      intent: { kind: "attach-worktree", workspaceId: "ws_home", workspaceName: "Feature Home" },
    });

    clickCheckbox(container);
    setInputByPlaceholder(container, "Optional", "Payments UI");
    await clickButton(container, "Add worktree");

    const optimisticTarget = onCreated.mock.calls[0]?.[1];
    expect(optimisticTarget).toMatch(/^checkout:co_optimistic_/);
    expect(queryClient.getQueryData<StateResponse>(["state"])?.checkouts).toEqual([
      expect.objectContaining({
        workspaceId: "ws_home",
        repoId: "repo_1",
        name: "payments-ui",
        displayName: "Payments UI",
        branch: "payments-ui",
      }),
    ]);

    if (!pendingCheckout.resolve) throw new Error("checkout request was not started");
    pendingCheckout.resolve(jsonResponse({ workspaceId: "ws_home", checkoutId: "co_new" }));
    await waitFor(() =>
      onCreated.mock.calls.some(
        ([workspaceId, targetKey]) => workspaceId === "ws_home" && targetKey === "checkout:co_new",
      ),
    );
    expect(queryClient.getQueryData<StateResponse>(["state"])?.checkouts.map((checkout) => checkout.id)).toEqual([
      "co_new",
    ]);
  });

  it("removes the pending worktree when checkout creation fails", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/workspaces/ws_home/checkouts") {
        return Promise.resolve(jsonResponse({ error: "checkout_name_invalid" }, { status: 400 }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    queryClient.setQueryData<StateResponse>(["state"], stateFixture({ repos: [repo()], workspaces: [workspace()] }));

    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({
      repos: [repo()],
      onCreated,
      intent: { kind: "attach-worktree", workspaceId: "ws_home", workspaceName: "Feature Home" },
    });

    clickCheckbox(container);
    setInputByPlaceholder(container, "Optional", "Payments UI");
    await clickButton(container, "Add worktree");

    expect(onCreated.mock.calls[0]?.[1]).toMatch(/^checkout:co_optimistic_/);
    await waitFor(() => queryClient.getQueryData<StateResponse>(["state"])?.checkouts.length === 0);
  });

  it("adds worktrees for multiple selected repos when opened from workspace Home", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === "/api/workspaces/ws_home/checkouts")
        return Promise.resolve(jsonResponse({ workspaceId: "ws_home", checkoutId: "co_new" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const onCreated = vi.fn();
    const container = renderCreateWorkspaceModal({
      repos: [repo(), repo({ id: "repo_2", name: "ApiRepo", rootPath: "/tmp/api-repo" })],
      onCreated,
      intent: { kind: "attach-worktree", workspaceId: "ws_home", workspaceName: "Feature Home" },
    });

    clickCheckbox(container, 0);
    clickCheckbox(container, 1);
    await clickButton(container, "Add worktrees");
    await waitFor(() => onCreated.mock.calls.some(([workspaceId]) => workspaceId === "ws_home"));

    const checkoutCalls = fetchMock.mock.calls.filter(
      ([input]) => String(input) === "/api/workspaces/ws_home/checkouts",
    );
    expect(checkoutCalls).toHaveLength(2);
    expect(checkoutCalls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { repoId: "repo_1", source: "default_branch" },
      { repoId: "repo_2", source: "default_branch" },
    ]);
  });
});

function renderCreateWorkspaceModal(overrides: {
  repos?: Repo[];
  grouping?: Parameters<typeof CreateWorkspaceModal>[0]["grouping"];
  intent?: Parameters<typeof CreateWorkspaceModal>[0]["intent"];
  onClose?: () => void;
  onCreated?: (workspaceId: string, targetKey?: string) => void;
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
          ToastProvider,
          null,
          createElement(CreateWorkspaceModal, {
            repos: overrides.repos ?? [],
            onClose: overrides.onClose ?? (() => undefined),
            onCreated: overrides.onCreated ?? (() => undefined),
            ...(overrides.grouping !== undefined ? { grouping: overrides.grouping } : {}),
            ...(overrides.intent !== undefined ? { intent: overrides.intent } : {}),
          }),
        ),
      ),
    );
  });
  return document.body;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(text),
  );
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function clickButton(container: HTMLElement, text: string) {
  const button = buttonByText(container, text);
  flushSync(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushPromises();
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

function stateFixture(input: {
  repos?: Repo[];
  workspaces?: Workspace[];
  checkouts?: WorktreeCheckout[];
}): StateResponse {
  return {
    repos: input.repos ?? [],
    workspaces: input.workspaces ?? [],
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

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_home",
    repoId: null,
    name: "Feature Home",
    path: "/work/feature-home",
    rootPath: "/work/feature-home",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    mode: "structured",
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
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_1",
    name: "MockRepo",
    rootPath: "/tmp/mock-repo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/mock-worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-06-03T00:00:00.000Z",
    updatedAt: "2026-06-03T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}
