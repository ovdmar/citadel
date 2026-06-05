import type { TerminalSession, WorkspaceSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { formatBytes, formatClock, formatPercent, resolveLiveWatchLabel } from "./cockpit-bottom-bar.js";

describe("footer health formatting", () => {
  it("formats unavailable percentages as n/a", () => {
    expect(formatPercent(null)).toBe("n/a");
  });

  it("rounds percentages for compact footer display", () => {
    expect(formatPercent(72.6)).toBe("73%");
  });

  it("formats bytes with compact binary units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(12 * 1024 ** 3)).toBe("12 GB");
  });

  it("formats the footer clock without seconds", () => {
    expect(formatClock(new Date("2026-06-05T09:07:30Z"))).toMatch(/^09:07$/);
  });
});

describe("footer live watch selection", () => {
  it("uses the active session label when it is live", () => {
    const active = session({ id: "sess_active", tmuxSessionName: "citadel_active" });
    expect(resolveLiveWatchLabel(active, [session({ id: "sess_other", tmuxSessionName: "citadel_other" })])).toBe(
      "citadel_active",
    );
  });

  it("falls back to another live workspace session when the active target has none", () => {
    expect(
      resolveLiveWatchLabel(null, [
        session({ id: "sess_closed", tmuxSessionName: "citadel_closed", closedAt: "2026-06-05T00:00:00.000Z" }),
        session({ id: "sess_live", ptySessionId: "pty_sess_live" }),
      ]),
    ).toBe("pty_sess_live");
  });

  it("returns null when there is no actual live watch", () => {
    expect(resolveLiveWatchLabel(null, [session({ closedAt: "2026-06-05T00:00:00.000Z" })])).toBeNull();
  });
});

function session(overrides: Partial<TerminalSession> = {}): WorkspaceSession {
  const base: TerminalSession = {
    id: "sess_1",
    workspaceId: "ws_1",
    displayName: "Terminal",
    status: "running",
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: null,
    tmuxSessionId: null,
    ptySessionId: null,
    kind: "terminal",
    runtimeId: null,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
  return { ...base, ...overrides };
}
