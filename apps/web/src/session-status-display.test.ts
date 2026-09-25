import type { AgentSession, TerminalSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveSessionDisplayLifecycleTone,
  deriveTerminalLifecycleTone,
  deriveWorkspaceDisplayLifecycleTone,
  sessionAttentionFingerprint,
  workspaceCardSessions,
} from "./session-status-display.js";

describe("session display lifecycle tones", () => {
  it("requests red attention for a finished agent until that exact status is acknowledged", () => {
    const session = agent({ status: "idle", lastStatusAt: "2026-06-05T10:00:00.000Z" });
    const fingerprint = sessionAttentionFingerprint(session);

    expect(fingerprint).toBeTruthy();
    expect(deriveSessionDisplayLifecycleTone(session, new Set([session.id]))).toBe("attention");
    expect(deriveSessionDisplayLifecycleTone(session, new Set())).toBe("done");
  });

  it("lets the workspace cascade red from any unacknowledged agent tab", () => {
    const quiet = agent({ id: "sess_seen", status: "idle", lastStatusAt: "2026-06-05T10:00:00.000Z" });
    const unseen = agent({ id: "sess_unseen", status: "idle", lastStatusAt: "2026-06-05T10:05:00.000Z" });

    expect(
      deriveWorkspaceDisplayLifecycleTone({
        sessions: [quiet, unseen],
        unseenAttentionSessionIds: new Set([unseen.id]),
      }),
    ).toBe("attention");
    expect(
      deriveWorkspaceDisplayLifecycleTone({
        sessions: [quiet, unseen],
        unseenAttentionSessionIds: new Set(),
      }),
    ).toBe("done");
  });

  it("shows terminal shells as running only while the backend status is running", () => {
    expect(deriveTerminalLifecycleTone(terminal({ status: "running" }))).toBe("running");
    expect(deriveTerminalLifecycleTone(terminal({ status: "idle" }))).toBe("done");
  });

  it("collects live workspace card sessions from both Home and nested checkout targets", () => {
    const home = agent({ id: "sess_home", workspaceId: "ws_1", checkoutId: null });
    const checkout = agent({ id: "sess_checkout", workspaceId: "ws_1", checkoutId: "co_api" });
    const otherCheckout = agent({ id: "sess_other", workspaceId: "ws_2", checkoutId: "co_other" });
    const closed = agent({
      id: "sess_closed",
      workspaceId: "ws_1",
      checkoutId: "co_api",
      closedAt: "2026-06-05T10:00:00.000Z",
    });

    expect(
      workspaceCardSessions([home, checkout, otherCheckout, closed], "ws_1", [{ id: "co_api" }]).map(
        (entry) => entry.id,
      ),
    ).toEqual(["sess_home", "sess_checkout"]);
  });
});

function agent(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    kind: "agent",
    runtimeId: "codex",
    displayName: "Codex",
    status: "running",
    statusReason: null,
    statusReasonAt: null,
    lastStatusAt: "2026-06-05T09:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_agent",
    tmuxSessionId: "$1",
    createdAt: "2026-06-05T09:00:00.000Z",
    updatedAt: "2026-06-05T09:00:00.000Z",
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "term_1",
    workspaceId: "ws_1",
    kind: "terminal",
    runtimeId: null,
    displayName: "Shell",
    status: "idle",
    statusReason: "shell_foreground",
    statusReasonAt: null,
    lastStatusAt: "2026-06-05T09:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_term",
    tmuxSessionId: "$2",
    createdAt: "2026-06-05T09:00:00.000Z",
    updatedAt: "2026-06-05T09:00:00.000Z",
    ...overrides,
  };
}
