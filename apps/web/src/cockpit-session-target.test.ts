import type { TerminalSession, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  checkoutIdFromTargetKey,
  sessionMatchesTarget,
  shouldShowInspectorPanel,
  targetKeyForSession,
  targetLabel,
} from "./cockpit-session-targets.js";

const ts = "2026-01-01T00:00:00.000Z";

describe("cockpit session target helpers", () => {
  it("keeps structured Home sessions separate from worktree checkout sessions", () => {
    const workspace = workspaceFixture({ mode: "structured" });
    const home = sessionFixture({ targetType: "workspace_home", checkoutId: null });
    const legacyHome = sessionFixture({ id: "legacy", targetType: undefined, checkoutId: null });
    const checkout = sessionFixture({ id: "checkout", targetType: "worktree_checkout", checkoutId: "co_1" });

    expect(sessionMatchesTarget(home, workspace, "workspace_home", null)).toBe(true);
    expect(sessionMatchesTarget(legacyHome, workspace, "workspace_home", null)).toBe(true);
    expect(sessionMatchesTarget(checkout, workspace, "workspace_home", null)).toBe(false);
    expect(sessionMatchesTarget(checkout, workspace, "worktree_checkout", "co_1")).toBe(true);
    expect(sessionMatchesTarget(checkout, workspace, "worktree_checkout", "co_2")).toBe(false);
  });

  it("does not split sessions by target for freestyle workspaces", () => {
    const workspace = workspaceFixture({ mode: "freestyle" });
    const checkout = sessionFixture({ targetType: "worktree_checkout", checkoutId: "co_1" });

    expect(sessionMatchesTarget(checkout, workspace, "workspace_home", null)).toBe(true);
  });

  it("derives target-qualified active session keys from started sessions", () => {
    expect(targetKeyForSession(sessionFixture({ targetType: "workspace_home", checkoutId: null }))).toBe("home");
    expect(targetKeyForSession(sessionFixture({ targetType: undefined, checkoutId: null }))).toBe("home");
    expect(targetKeyForSession(sessionFixture({ targetType: "worktree_checkout", checkoutId: "co_1" }))).toBe(
      "checkout:co_1",
    );
  });

  it("resolves checkout target keys and labels only for live checkouts", () => {
    const checkouts = [checkoutFixture({ id: "co_1", name: "api" }), checkoutFixture({ id: "co_2", name: "web" })];

    expect(checkoutIdFromTargetKey("home", checkouts)).toBeNull();
    expect(checkoutIdFromTargetKey("checkout:co_1", checkouts)).toBe("co_1");
    expect(checkoutIdFromTargetKey("checkout:archived", checkouts)).toBeNull();
    expect(targetLabel("workspace_home", null, checkouts)).toBe("Home");
    expect(targetLabel("worktree_checkout", "co_2", checkouts)).toBe("web");
    expect(targetLabel("worktree_checkout", "missing", checkouts)).toBe("Checkout");
  });

  it("hides the inspector only for structured workspace Home targets", () => {
    const structured = workspaceFixture({ mode: "structured" });
    const freestyle = workspaceFixture({ mode: "freestyle" });

    expect(shouldShowInspectorPanel(structured, "workspace_home")).toBe(false);
    expect(shouldShowInspectorPanel(structured, "worktree_checkout")).toBe(true);
    expect(shouldShowInspectorPanel(freestyle, "workspace_home")).toBe(true);
  });
});

function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: "repo_1",
    name: "Workspace",
    path: "/tmp/workspace",
    branch: "main",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

function sessionFixture(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "idle",
    statusReason: null,
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "tmux",
    tmuxSessionId: "$0",
    targetType: "workspace_home",
    checkoutId: null,
    createdAt: ts,
    updatedAt: ts,
    lastStatusAt: ts,
    lastOutputAt: ts,
    endedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function checkoutFixture(overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id: "co_1",
    workspaceId: "ws_1",
    repoId: "repo_1",
    name: "checkout",
    path: "/tmp/workspace/checkout",
    branch: "feature/checkout",
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
