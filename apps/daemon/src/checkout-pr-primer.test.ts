import type { AgentSession, Repo, VersionControlSummary, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { createCheckoutPrPrimeOnAgentFinish, shouldPrimeCheckoutPr } from "./checkout-pr-primer.js";

const nowIso = "2026-06-05T00:00:00.000Z";

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Workspace",
    path: "/tmp/ws",
    branch: "main",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
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
    createdAt: nowIso,
    updatedAt: nowIso,
    archivedAt: null,
    ...overrides,
  };
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_a",
    name: "Repo",
    rootPath: "/tmp/repo",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/tmp/repo/worktrees",
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: ["github-gh"],
    deployHookCommand: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    archivedAt: null,
    ...overrides,
  };
}

function checkout(overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id: "co_api",
    workspaceId: "ws_a",
    repoId: "repo_a",
    name: "api",
    path: "/tmp/ws/api",
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
    createdAt: nowIso,
    updatedAt: nowIso,
    archivedAt: null,
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_a",
    kind: "agent",
    workspaceId: "ws_a",
    targetType: "worktree_checkout",
    checkoutId: "co_api",
    displayName: "Agent",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "tmux_sess",
    tmuxSessionId: null,
    runtimeId: "codex",
    createdAt: nowIso,
    updatedAt: nowIso,
    ...overrides,
  };
}

function vc(): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "healthy",
    reason: null,
    defaultBranch: "main",
    currentBranch: "feature/api",
    remotes: ["origin"],
    pullRequest: null,
    checkedAt: nowIso,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("checkout PR primer", () => {
  it("only primes when a running agent reaches a terminal work status", () => {
    const base = session();
    expect(shouldPrimeCheckoutPr({ session: base, previousStatus: "running", nextStatus: "idle" })).toBe(true);
    expect(shouldPrimeCheckoutPr({ session: base, previousStatus: "running", nextStatus: "waiting_for_input" })).toBe(
      true,
    );
    expect(shouldPrimeCheckoutPr({ session: base, previousStatus: "idle", nextStatus: "idle" })).toBe(false);
    expect(shouldPrimeCheckoutPr({ session: base, previousStatus: "running", nextStatus: "rate_limited" })).toBe(false);
    expect(
      shouldPrimeCheckoutPr({
        session: session({ targetType: "workspace_home", checkoutId: null }),
        previousStatus: "running",
        nextStatus: "idle",
      }),
    ).toBe(true);
  });

  it("forces one checkout PR refresh and suppresses repeated same-head transitions inside the debounce", async () => {
    let nowMs = 1_000_000;
    const fetchCheckoutVersionControl = vi.fn(async () => vc());
    const fetchVersionControl = vi.fn(async () => vc());
    const onRefreshed = vi.fn();
    const primer = createCheckoutPrPrimeOnAgentFinish({
      store: {
        findWorkspaceCheckout: () => checkout(),
        listWorkspaces: () => [workspace()],
        listRepos: () => [repo()],
      },
      github: { fetchCheckoutVersionControl, fetchVersionControl },
      now: () => nowMs,
      debounceMs: 120_000,
      readHead: () => "sha-a",
      onRefreshed,
    });

    primer({ session: session(), previousStatus: "running", nextStatus: "idle" });
    primer({ session: session(), previousStatus: "running", nextStatus: "idle" });
    await flush();

    expect(fetchCheckoutVersionControl).toHaveBeenCalledTimes(1);
    expect(fetchCheckoutVersionControl).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_a" }),
      expect.objectContaining({ id: "co_api" }),
      expect.objectContaining({ id: "repo_a" }),
      "vc:ws_a:checkout:co_api",
      { intent: "automatic", force: true, staleWhileRevalidate: true },
    );
    expect(fetchVersionControl).not.toHaveBeenCalled();
    expect(onRefreshed).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_a" }),
      expect.objectContaining({ id: "co_api" }),
    );

    nowMs += 121_000;
    primer({ session: session(), previousStatus: "running", nextStatus: "idle" });
    await flush();
    expect(fetchCheckoutVersionControl).toHaveBeenCalledTimes(2);
  });

  it("allows a second forced refresh for the same checkout when local HEAD changed", async () => {
    const fetchCheckoutVersionControl = vi.fn(async () => vc());
    const fetchVersionControl = vi.fn(async () => vc());
    let head = "sha-a";
    const primer = createCheckoutPrPrimeOnAgentFinish({
      store: {
        findWorkspaceCheckout: () => checkout(),
        listWorkspaces: () => [workspace()],
        listRepos: () => [repo()],
      },
      github: { fetchCheckoutVersionControl, fetchVersionControl },
      now: () => 1_000_000,
      debounceMs: 120_000,
      readHead: () => head,
    });

    primer({ session: session(), previousStatus: "running", nextStatus: "idle" });
    head = "sha-b";
    primer({ session: session(), previousStatus: "running", nextStatus: "idle" });
    await flush();

    expect(fetchCheckoutVersionControl).toHaveBeenCalledTimes(2);
  });

  it("forces a workspace PR refresh for a non-checkout agent finishing work", async () => {
    const fetchCheckoutVersionControl = vi.fn(async () => vc());
    const fetchVersionControl = vi.fn(async () => vc());
    const onRefreshed = vi.fn();
    const primer = createCheckoutPrPrimeOnAgentFinish({
      store: {
        findWorkspaceCheckout: () => null,
        listWorkspaces: () => [workspace({ kind: "worktree" })],
        listRepos: () => [repo()],
      },
      github: { fetchCheckoutVersionControl, fetchVersionControl },
      now: () => 1_000_000,
      debounceMs: 120_000,
      readHead: () => "sha-workspace",
      onRefreshed,
    });

    primer({
      session: session({ targetType: "workspace_home", checkoutId: null }),
      previousStatus: "running",
      nextStatus: "idle",
    });
    await flush();

    expect(fetchCheckoutVersionControl).not.toHaveBeenCalled();
    expect(fetchVersionControl).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ws_a" }),
      expect.objectContaining({ id: "repo_a" }),
      "vc:ws_a:2026-06-05T00:00:00.000Z",
      { intent: "automatic", force: true, staleWhileRevalidate: true },
    );
    expect(onRefreshed).toHaveBeenCalledWith(expect.objectContaining({ id: "ws_a" }), null);
  });
});
