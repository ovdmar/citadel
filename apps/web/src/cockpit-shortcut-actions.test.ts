import type { AgentRuntime, Workspace, WorkspaceSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { type ShortcutDeps, resolveShortcutAction } from "./cockpit-shortcut-actions.js";
import type { GroupNode } from "./navigator-groups.js";
import type { ShortcutMatch } from "./shortcuts.js";

const ts = "2026-01-01T00:00:00.000Z";

function makeWorkspace(id: string): Workspace {
  return {
    id,
    repoId: "r1",
    name: id,
    path: `/wt/${id}`,
    branch: `feat/${id}`,
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  };
}

function makeSession(id: string, workspaceId: string): WorkspaceSession {
  return {
    id,
    workspaceId,
    kind: "terminal",
    runtimeId: null,
    displayName: id,
    status: "idle",
    statusReason: null,
    transport: "connected",
    tmuxSessionName: "tmux",
    tmuxSessionId: "$0",
    createdAt: ts,
    updatedAt: ts,
    lastStatusAt: ts,
    lastOutputAt: ts,
    endedAt: null,
    exitCode: null,
  };
}

function makeRuntime(id: string, healthy = true): AgentRuntime {
  return {
    id,
    displayName: id.toUpperCase(),
    command: id,
    args: [],
    health: healthy ? "healthy" : "unavailable",
    healthReason: null,
    capabilities: {
      supportsPrompt: true,
      supportsResume: false,
      supportsModelSelection: false,
      supportsTranscript: false,
      supportsStatusDetection: false,
      supportsNonInteractiveGoal: false,
      supportsShell: true,
      supportsUsage: false,
      supportsTui: false,
    },
  };
}

function match(id: ShortcutMatch["id"], index?: number): ShortcutMatch {
  const base: ShortcutMatch = {
    id,
    chord: { id, modifier: "primary", shift: false, key: "k" },
  };
  if (index !== undefined) base.index = index;
  return base;
}

const baseDeps = (overrides: Partial<ShortcutDeps> = {}): ShortcutDeps => ({
  flatWorkspaceIds: [],
  activeWorkspace: null,
  activeWorkspaceSessions: [],
  runtimes: [],
  navTree: [],
  ...overrides,
});

describe("resolveShortcutAction", () => {
  it("maps command-palette to toggle-command-palette", () => {
    expect(resolveShortcutAction(match("command-palette"), baseDeps())).toEqual({
      type: "toggle-command-palette",
    });
  });

  it("maps close-overlay to close-command-palette", () => {
    expect(resolveShortcutAction(match("close-overlay"), baseDeps())).toEqual({
      type: "close-command-palette",
    });
  });

  it("maps nav-workspace to the indexed workspace id", () => {
    const deps = baseDeps({ flatWorkspaceIds: ["w1", "w2", "w3"] });
    expect(resolveShortcutAction(match("nav-workspace", 1), deps)).toEqual({
      type: "nav-workspace",
      workspaceId: "w2",
      expandGroupPath: null,
    });
  });

  it("nav-workspace is a no-op when the index is beyond the workspace count", () => {
    const deps = baseDeps({ flatWorkspaceIds: ["w1", "w2"] });
    expect(resolveShortcutAction(match("nav-workspace", 5), deps)).toEqual({ type: "noop" });
  });

  it("nav-workspace returns an expandGroupPath when the tree is present and the workspace is found", () => {
    const leaf: GroupNode = {
      kind: "leaf",
      id: "repo=alpha",
      path: "repo=alpha",
      label: "alpha",
      count: 1,
      workspaces: [{ workspace: makeWorkspace("w1"), sessions: [] }],
    };
    const deps = baseDeps({ flatWorkspaceIds: ["w1"], navTree: [leaf] });
    expect(resolveShortcutAction(match("nav-workspace", 0), deps)).toEqual({
      type: "nav-workspace",
      workspaceId: "w1",
      expandGroupPath: "repo=alpha",
    });
  });

  it("nav-session resolves the active workspace's Nth session", () => {
    const ws = makeWorkspace("w1");
    const sessions = [makeSession("s1", "w1"), makeSession("s2", "w1")];
    const deps = baseDeps({ activeWorkspace: ws, activeWorkspaceSessions: sessions });
    expect(resolveShortcutAction(match("nav-session", 1), deps)).toEqual({
      type: "nav-session",
      workspaceId: "w1",
      sessionId: "s2",
    });
  });

  it("nav-session is a no-op when there is no active workspace", () => {
    const sessions = [makeSession("s1", "w1")];
    const deps = baseDeps({ activeWorkspace: null, activeWorkspaceSessions: sessions });
    expect(resolveShortcutAction(match("nav-session", 0), deps)).toEqual({ type: "noop" });
  });

  it("nav-session is a no-op when the index exceeds the session count", () => {
    const ws = makeWorkspace("w1");
    const deps = baseDeps({ activeWorkspace: ws, activeWorkspaceSessions: [] });
    expect(resolveShortcutAction(match("nav-session", 0), deps)).toEqual({ type: "noop" });
  });

  it("spawn-terminal targets the active workspace with the shell runtime", () => {
    const ws = makeWorkspace("w1");
    const deps = baseDeps({ activeWorkspace: ws });
    expect(resolveShortcutAction(match("spawn-terminal"), deps)).toEqual({
      type: "spawn-terminal",
      workspaceId: "w1",
    });
  });

  it("spawn-terminal is a no-op when there is no active workspace", () => {
    expect(resolveShortcutAction(match("spawn-terminal"), baseDeps())).toEqual({ type: "noop" });
  });

  it("spawn-agent uses claude-code when present and healthy", () => {
    const ws = makeWorkspace("w1");
    const deps = baseDeps({
      activeWorkspace: ws,
      runtimes: [makeRuntime("codex"), makeRuntime("claude-code")],
    });
    expect(resolveShortcutAction(match("spawn-agent"), deps)).toEqual({
      type: "spawn-agent",
      workspaceId: "w1",
      runtimeId: "claude-code",
      displayName: "CLAUDE-CODE",
    });
  });

  it("spawn-agent falls back to the first healthy runtime", () => {
    const ws = makeWorkspace("w1");
    const codex = makeRuntime("codex");
    const deps = baseDeps({ activeWorkspace: ws, runtimes: [codex, makeRuntime("cursor-agent")] });
    expect(resolveShortcutAction(match("spawn-agent"), deps)).toMatchObject({
      type: "spawn-agent",
      runtimeId: "codex",
    });
  });

  it("spawn-agent returns spawn-agent-no-runtime when no agent runtime is healthy", () => {
    const ws = makeWorkspace("w1");
    const deps = baseDeps({ activeWorkspace: ws, runtimes: [makeRuntime("codex", false)] });
    expect(resolveShortcutAction(match("spawn-agent"), deps)).toEqual({
      type: "spawn-agent-no-runtime",
    });
  });

  it("spawn-agent is a no-op when there is no active workspace", () => {
    expect(resolveShortcutAction(match("spawn-agent"), baseDeps({ runtimes: [makeRuntime("codex")] }))).toEqual({
      type: "noop",
    });
  });
});
