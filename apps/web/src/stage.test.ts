// @vitest-environment happy-dom

import type { AgentRuntime, RoleTemplate, TerminalProfile, TerminalSession, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  buildStageLaunchEntryGroups,
  freestyleStageActions,
  retainRecentTerminalIds,
  stableVisitedSessions,
  stableWorkspaceSessionIdsKey,
  structuredStageActions,
} from "./stage.js";

describe("Stage terminal pane ordering", () => {
  it("keeps visited terminal panes in visit order when state polling reorders sessions", () => {
    const first = sessionFixture({ id: "sess_a", tabId: "tab_a", updatedAt: "2026-05-28T20:00:00.000Z" });
    const second = sessionFixture({ id: "sess_b", tabId: "tab_b", updatedAt: "2026-05-28T20:00:05.000Z" });
    const visited = new Set(["sess_a", "sess_b"]);

    expect(stableVisitedSessions([second, first], visited).map((session) => session.id)).toEqual(["sess_a", "sess_b"]);
    expect(stableVisitedSessions([first, second], visited).map((session) => session.id)).toEqual(["sess_a", "sess_b"]);
  });

  it("keys terminal recovery from tab order, not updated-at order", () => {
    const first = sessionFixture({ id: "sess_a", tabId: "tab_a", updatedAt: "2026-05-28T20:00:00.000Z" });
    const second = sessionFixture({ id: "sess_b", tabId: "tab_b", updatedAt: "2026-05-28T20:00:05.000Z" });

    expect(stableWorkspaceSessionIdsKey([second, first])).toBe(stableWorkspaceSessionIdsKey([first, second]));
  });

  it("retains only the five most recently visited terminal panes", () => {
    const visited = new Set(["sess_a", "sess_b", "sess_c", "sess_d", "sess_e", "sess_f"]);
    const live = new Set(visited);

    expect([...retainRecentTerminalIds(visited, "sess_b", live)]).toEqual([
      "sess_c",
      "sess_d",
      "sess_e",
      "sess_f",
      "sess_b",
    ]);
  });

  it("drops sessions that no longer exist before applying the LRU cap", () => {
    const visited = new Set(["sess_a", "sess_b", "sess_c", "sess_d", "sess_e", "sess_f"]);
    const live = new Set(["sess_b", "sess_d", "sess_e", "sess_f"]);

    expect([...retainRecentTerminalIds(visited, "sess_b", live)]).toEqual(["sess_d", "sess_e", "sess_f", "sess_b"]);
  });

  it("offers structured Home roles on Home and checkout roles on checkouts", () => {
    const workspace = workspaceFixture({ mode: "structured" });

    expect(
      structuredStageActions({ workspace, targetType: "workspace_home", checkoutId: null }).map((action) => [
        action.label,
        action.toolName,
      ]),
    ).toEqual([
      ["PM", "launch_pm_agent"],
      ["Architect", "launch_architect_agent"],
      ["Manager", "start_workspace_manager"],
    ]);
    expect(
      structuredStageActions({ workspace, targetType: "worktree_checkout", checkoutId: "co_1" }).map((action) => [
        action.label,
        action.arguments,
      ]),
    ).toEqual([
      ["Implementation", { checkoutId: "co_1" }],
      ["Prototype", { checkoutId: "co_1" }],
    ]);
  });

  it("keeps structured role actions out of freestyle workspaces", () => {
    expect(
      structuredStageActions({
        workspace: workspaceFixture({ mode: "freestyle" }),
        targetType: "workspace_home",
        checkoutId: null,
      }),
    ).toEqual([]);
  });

  it("offers PM and Prototype specialized actions for freestyle workspaces", () => {
    expect(
      freestyleStageActions({
        workspace: workspaceFixture({ mode: "freestyle" }),
        templates: [
          roleTemplate("pm", "PM"),
          roleTemplate("prototype", "Prototype"),
          roleTemplate("manager", "Manager"),
        ],
      }).map((action) => [action.id, action.label]),
    ).toEqual([
      ["pm", "PM"],
      ["prototype", "Prototype"],
    ]);
  });

  it("builds shared launch entries for the add menu and empty stage", () => {
    const groups = buildStageLaunchEntryGroups({
      structuredActions: structuredStageActions({
        workspace: workspaceFixture({ mode: "structured" }),
        targetType: "workspace_home",
        checkoutId: null,
      }),
      directRoleActions: [],
      terminal: terminalProfileFixture(),
      runtimes: [
        runtimeFixture({ id: "claude-code", displayName: "Claude Code", health: "healthy" }),
        runtimeFixture({
          id: "codex",
          displayName: "Codex",
          health: "unavailable",
          healthReason: "command missing",
        }),
      ],
      addDisabled: false,
      atSessionCap: false,
    });

    expect(
      groups.map((group) => [
        group.label,
        group.entries.map((entry) => [entry.type, entry.label, entry.disabled, entry.detail]),
      ]),
    ).toEqual([
      [
        "Specialized",
        [
          ["structured", "PM", false, null],
          ["structured", "Architect", false, null],
          ["structured", "Manager", false, null],
        ],
      ],
      [
        "Freestyle",
        [
          ["terminal", "Shell", false, null],
          ["runtime", "Claude Code", false, "healthy"],
          ["runtime", "Codex", true, "unavailable"],
        ],
      ],
    ]);
  });

  it("disables every launch entry when the session cap is reached", () => {
    const groups = buildStageLaunchEntryGroups({
      structuredActions: [],
      directRoleActions: [],
      terminal: terminalProfileFixture(),
      runtimes: [runtimeFixture({ health: "healthy" })],
      addDisabled: true,
      atSessionCap: true,
      sessionCap: 2,
    });

    expect(groups.flatMap((group) => group.entries).map((entry) => [entry.label, entry.disabled, entry.title])).toEqual(
      [
        ["Shell", true, "Cap reached (2). Close a session first."],
        ["Claude Code", true, "Cap reached (2). Close a session first."],
      ],
    );
  });
});

function sessionFixture(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "idle",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_sess_1",
    tmuxSessionId: "tmux_1",
    createdAt: "2026-05-28T19:00:00.000Z",
    updatedAt: "2026-05-28T19:00:00.000Z",
    ...overrides,
  };
}

function workspaceFixture(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_1",
    repoId: null,
    name: "Workspace",
    path: "/work/ws",
    rootPath: "/work/ws",
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "architecture",
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
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function roleTemplate(role: RoleTemplate["role"], displayName: string): RoleTemplate {
  return {
    role,
    displayName,
    systemPrompt: `${displayName} prompt`,
    launchSettings: {
      runtimeId: "codex",
      model: "gpt-5.4",
      effort: "high",
      fastMode: null,
      contextMode: null,
    },
    actions: [],
    builtIn: true,
    resettable: true,
    updatedAt: null,
  };
}

function terminalProfileFixture(overrides: Partial<TerminalProfile> = {}): TerminalProfile {
  return {
    displayName: "Shell",
    command: "bash",
    args: ["-l"],
    ...overrides,
  };
}

function runtimeFixture(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    command: "claude",
    args: [],
    health: "healthy",
    healthReason: null,
    capabilities: {
      supportsPrompt: true,
      supportsResume: true,
      supportsModelSelection: false,
      supportsTranscript: true,
      supportsStatusDetection: true,
      supportsNonInteractiveGoal: true,
      supportsShell: true,
      supportsUsage: false,
      supportsTui: true,
    },
    ...overrides,
  };
}
