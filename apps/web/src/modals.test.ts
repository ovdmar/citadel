// @vitest-environment happy-dom

import type { AgentRuntime, Namespace, Repo } from "@citadel/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing__ } from "./add-repo-modal.js";
import { queryClient } from "./api.js";
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

  it("creates repo worktrees when repository grouping is active", () => {
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo"])).toBe("repo-worktree");
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo", "status"])).toBe("repo-worktree");
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
      if (url === "/api/agent-templates") return Promise.resolve(jsonResponse({ roles: [] }));
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

    await clickButton(container, "Create workspace");

    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/workspaces/home")).toBe(true);

    if (!pendingHome.resolve) throw new Error("workspace Home request was not started");
    pendingHome.resolve(jsonResponse({ workspaceId: "ws_new" }));
    await waitFor(() => onCreated.mock.calls.some(([workspaceId]) => workspaceId === "ws_new"));

    expect(onCreated).toHaveBeenCalledWith("ws_new");
  });

  it("leaves blank repo-group worktree names and branches for daemon-generated defaults", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = String(input);
      if (url === "/api/agent-templates") return Promise.resolve(jsonResponse({ roles: [] }));
      if (url === "/api/workspaces/home") return Promise.resolve(jsonResponse({ workspaceId: "ws_new" }));
      if (url === "/api/workspaces/ws_new/checkouts")
        return Promise.resolve(jsonResponse({ workspaceId: "ws_new", checkoutId: "co_new" }));
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    const container = renderCreateWorkspaceModal({ grouping: ["repo"], repos: [repo()] });

    await clickButton(container, "Create worktree");
    await waitFor(() => fetchMock.mock.calls.some(([input]) => String(input) === "/api/workspaces/ws_new/checkouts"));

    const checkoutCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/workspaces/ws_new/checkouts");
    expect(checkoutCall).toBeTruthy();
    const body = JSON.parse(String(checkoutCall?.[1]?.body));
    expect(body).toMatchObject({ repoId: "repo_1", source: "default_branch", name: "" });
    expect(body).not.toHaveProperty("branch");
  });
});

function renderCreateWorkspaceModal(overrides: {
  repos?: Repo[];
  runtimes?: AgentRuntime[];
  namespaces?: Namespace[];
  grouping?: Parameters<typeof CreateWorkspaceModal>[0]["grouping"];
  onClose?: () => void;
  onCreated?: (workspaceId: string) => void;
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
            runtimes: overrides.runtimes ?? [],
            namespaces: overrides.namespaces ?? [],
            onClose: overrides.onClose ?? (() => undefined),
            onCreated: overrides.onCreated ?? (() => undefined),
            ...(overrides.grouping !== undefined ? { grouping: overrides.grouping } : {}),
          }),
        ),
      ),
    );
  });
  return rootElement;
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

function repo(): Repo {
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
  };
}
