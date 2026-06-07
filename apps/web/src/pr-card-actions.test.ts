// @vitest-environment happy-dom

import type { ProviderHealth, PullRequestSummary, Workspace } from "@citadel/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrCardActionSlot, mergeDisabledReason } from "./pr-card-actions.js";

const roots: Root[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
  flushSync(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
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

  it("renders admin bypass unchecked and sends admin merge payload only when checked", async () => {
    const fetchMock = installMergeFetchMock([{ status: 200, body: { ok: true } }]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"] });

    await openMergeMenu(harness.container);
    const bypass = adminBypassItem(harness.container);
    expect(bypass.getAttribute("aria-checked")).toBe("false");
    expect(bypass.textContent).toContain("Admin bypass");

    await flushReact(() => bypass.click());
    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("true");
    await clickStrategy(harness.container, "Squash & merge");

    expect(mergeBodies(fetchMock)).toEqual([{ strategy: "squash", admin: true }]);
  });

  it("resets admin bypass when the merge menu closes and reopens", async () => {
    installMergeFetchMock([{ status: 200, body: { ok: true } }]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"] });

    await openMergeMenu(harness.container);
    await flushReact(() => adminBypassItem(harness.container).click());
    await openMergeMenu(harness.container);
    await openMergeMenu(harness.container);

    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("false");
  });

  it("resets admin bypass when the PR context changes", async () => {
    installMergeFetchMock([{ status: 200, body: { ok: true } }]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"], number: 42 });

    await openMergeMenu(harness.container);
    await flushReact(() => adminBypassItem(harness.container).click());
    harness.rerender({ allowedMergeStrategies: ["squash"], number: 43 });
    await openMergeMenu(harness.container);

    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("false");
  });

  it("resets admin bypass when the workspace changes with the same PR number", async () => {
    const fetchMock = installMergeFetchMock([{ status: 200, body: { ok: true } }]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"], number: 42 }, { id: "ws_a" });

    await openMergeMenu(harness.container);
    await flushReact(() => adminBypassItem(harness.container).click());
    harness.rerender({ allowedMergeStrategies: ["squash"], number: 42 }, { id: "ws_b" });
    await openMergeMenu(harness.container);

    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("false");
    await clickStrategy(harness.container, "Squash & merge");
    expect(mergeBodies(fetchMock)).toEqual([{ strategy: "squash" }]);
    expect(mergePaths(fetchMock)).toEqual(["/api/workspaces/ws_b/pr-merge"]);
  });

  it("clears admin bypass when merge eligibility hides the menu", async () => {
    const fetchMock = installMergeFetchMock([{ status: 200, body: { ok: true } }]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"], mergeable: "mergeable" });

    await openMergeMenu(harness.container);
    await flushReact(() => adminBypassItem(harness.container).click());
    harness.rerender({ allowedMergeStrategies: ["squash"], mergeable: "unknown" });
    await flushReact(() => undefined);
    expect(harness.container.querySelector('[role="menuitemcheckbox"]')).toBeNull();

    harness.rerender({ allowedMergeStrategies: ["squash"], mergeable: "mergeable" });
    await flushReact(() => undefined);
    await openMergeMenu(harness.container);

    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("false");
    await clickStrategy(harness.container, "Squash & merge");
    expect(mergeBodies(fetchMock)).toEqual([{ strategy: "squash" }]);
  });

  it("resets admin bypass after a failed merge before the next normal merge", async () => {
    const fetchMock = installMergeFetchMock([
      { status: 409, body: { ok: false, reason: "gh_error", detail: "merge rejected" } },
      { status: 200, body: { ok: true } },
    ]);
    const harness = renderActionHarness({ allowedMergeStrategies: ["squash"] });

    await openMergeMenu(harness.container);
    await flushReact(() => adminBypassItem(harness.container).click());
    await clickStrategy(harness.container, "Squash & merge");
    expect(adminBypassItem(harness.container).getAttribute("aria-checked")).toBe("false");
    await settle();
    await flushReact(() => undefined);

    await clickStrategy(harness.container, "Squash & merge");
    expect(mergeBodies(fetchMock)).toEqual([{ strategy: "squash", admin: true }, { strategy: "squash" }]);
  });
});

function renderAction(prOverrides: Partial<PullRequestSummary>) {
  return renderActionHarness(prOverrides).container;
}

function renderActionHarness(prOverrides: Partial<PullRequestSummary>, workspaceOverrides: Partial<Workspace> = {}) {
  const rootElement = document.createElement("div");
  document.body.appendChild(rootElement);
  const root = createRoot(rootElement);
  roots.push(root);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  client.setQueryData(["provider-health"], { providerHealth: [providerHealth({ status: "healthy" })] });

  const render = (nextPr: Partial<PullRequestSummary>, nextWorkspace: Partial<Workspace>) => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PrCardActionSlot, {
          workspace: workspace(nextWorkspace),
          pr: pullRequest(nextPr),
          prTone: "pending",
        }),
      ),
    );
  };

  flushSync(() => {
    render(prOverrides, workspaceOverrides);
  });

  return {
    container: rootElement,
    rerender(nextPr: Partial<PullRequestSummary>, nextWorkspace: Partial<Workspace> = workspaceOverrides) {
      flushSync(() => render(nextPr, nextWorkspace));
    },
  };
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

function workspace(overrides: Partial<Workspace> = {}): Workspace {
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
    ...overrides,
  };
}

async function openMergeMenu(container: HTMLElement) {
  const mergeButton = container.querySelector<HTMLButtonElement>("button.pr-card-btn-merge");
  if (!mergeButton) throw new Error("merge button missing");
  await flushReact(() => mergeButton.click());
}

async function clickStrategy(container: HTMLElement, label: string) {
  const strategy = Array.from(container.querySelectorAll<HTMLButtonElement>(".pr-card-merge-strategy")).find((button) =>
    button.textContent?.includes(label),
  );
  if (!strategy) throw new Error(`strategy button missing: ${label}`);
  await flushReact(() => strategy.click());
}

function adminBypassItem(container: HTMLElement): HTMLButtonElement {
  const item = container.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]');
  if (!item) throw new Error("admin bypass item missing");
  return item;
}

type FetchMock = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

function installMergeFetchMock(responses: Array<{ status: number; body: unknown }>): FetchMock {
  let index = 0;
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
    const response = responses[Math.min(index, responses.length - 1)] ?? { status: 200, body: { ok: true } };
    index += 1;
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mergeBodies(fetchMock: FetchMock): unknown[] {
  return fetchMock.mock.calls
    .filter(([path]) => String(path).includes("/pr-merge"))
    .map(([, init]) => JSON.parse(String(init?.body ?? "{}")) as unknown);
}

function mergePaths(fetchMock: FetchMock): string[] {
  return fetchMock.mock.calls.map(([path]) => String(path)).filter((path) => path.includes("/pr-merge"));
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushReact(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
  await settle();
}
