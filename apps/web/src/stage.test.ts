// @vitest-environment happy-dom

import type { TerminalSession, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
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
      ["Implementation", { checkoutId: "co_1", actor: "human" }],
      ["Prototype", { checkoutId: "co_1", actor: "human" }],
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
