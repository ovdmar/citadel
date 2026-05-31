import type { SqliteStore } from "@citadel/db";
import type { TtydManager } from "@citadel/terminal";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reapOrphans } from "./orphan-reaper.js";

const terminalState = vi.hoisted(() => ({
  liveTmuxSessions: new Set<string>(),
  killedTmuxSessions: [] as string[],
  tmuxSessionExists: new Map<string, boolean>(),
}));

vi.mock("@citadel/terminal", () => ({
  listAllTmuxSessions: vi.fn(() => new Set(terminalState.liveTmuxSessions)),
  killTmuxSession: vi.fn((name: string) => {
    terminalState.killedTmuxSessions.push(name);
  }),
  tmuxSessionExists: vi.fn((name: string) => terminalState.tmuxSessionExists.get(name) ?? false),
}));

function fakeStore(sessionNames: string[] = []): SqliteStore {
  return {
    listWorkspaceSessions: () => sessionNames.map((tmuxSessionName) => ({ tmuxSessionName })),
  } as unknown as SqliteStore;
}

function fakeTtyd(): TtydManager {
  return {
    list: () => [],
  } as unknown as TtydManager;
}

describe("reapOrphans", () => {
  beforeEach(() => {
    terminalState.liveTmuxSessions.clear();
    terminalState.killedTmuxSessions.splice(0);
    terminalState.tmuxSessionExists.clear();
  });

  it("does not kill tmux sessions when the caller marks tmux reaping unsafe", async () => {
    terminalState.liveTmuxSessions.add("citadel_prod_live");
    const diagnostics: Array<{ category: string; event: string; data?: Record<string, unknown> }> = [];

    const summary = await reapOrphans({
      store: fakeStore(),
      ttyd: fakeTtyd(),
      diagnostics: {
        log: (category: string, event: string, data?: Record<string, unknown>) => {
          diagnostics.push(data === undefined ? { category, event } : { category, event, data });
        },
      },
      reapTmuxSessions: false,
    });

    expect(summary.tmuxReaped).toEqual([]);
    expect(terminalState.killedTmuxSessions).toEqual([]);
    expect(diagnostics).toContainEqual({
      category: "reaper",
      event: "tmux.skipped",
      data: { reason: "unsafe-shared-socket" },
    });
  });

  it("kills unreferenced tmux sessions only when tmux reaping is enabled", async () => {
    terminalState.liveTmuxSessions.add("citadel_unknown");
    terminalState.liveTmuxSessions.add("citadel_referenced");

    const summary = await reapOrphans({
      store: fakeStore(["citadel_referenced"]),
      ttyd: fakeTtyd(),
      reapTmuxSessions: true,
    });

    expect(summary.tmuxReaped).toEqual(["citadel_unknown"]);
    expect(terminalState.killedTmuxSessions).toEqual(["citadel_unknown"]);
  });
});
