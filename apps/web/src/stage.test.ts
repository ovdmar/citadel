import type { AgentSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { retainRecentTerminalIds, stableVisitedSessions, stableWorkspaceSessionIdsKey } from "./stage.js";

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
});

function sessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "shell",
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
