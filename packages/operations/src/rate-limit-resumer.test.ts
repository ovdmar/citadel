import type { ActivityEvent, AgentSession, Workspace } from "@citadel/contracts";
import type { RuntimeStatusAdapter } from "@citadel/runtimes";
import { describe, expect, it, vi } from "vitest";
import { resumeRateLimitedSession } from "./rate-limit-resumer.js";

function makeSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_rl",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "rate_limited",
    statusReason: "rate_limited:2026-05-26T10:00:00.000Z",
    lastStatusAt: "2026-05-26T10:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    tmuxSessionName: "citadel_rl",
    tmuxSessionId: "$2",
    createdAt: "2026-05-26T09:00:00.000Z",
    updatedAt: "2026-05-26T10:00:00.000Z",
    ...over,
  };
}

function makeAdapter(
  detect: () => { resetAt: string | null } | null = () => ({ resetAt: null }),
): RuntimeStatusAdapter {
  return {
    runtimeId: "claude-code",
    createSessionState: () => ({ ticksObserved: 0, lastPaneHash: null }),
    observe: vi.fn(() => null),
    detectRateLimit: vi.fn(detect),
  };
}

function makeStore(over: { sessions?: AgentSession[]; workspaces?: Workspace[] } = {}) {
  const activity: ActivityEvent[] = [];
  return {
    activity,
    store: {
      listSessions: () => over.sessions ?? [makeSession()],
      listWorkspaces: () =>
        over.workspaces ?? [
          {
            id: "ws_1",
            repoId: "repo_1",
            name: "ws",
            path: "/tmp/ws",
            branch: "main",
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
            createdAt: "",
            updatedAt: "",
            archivedAt: null,
          },
        ],
      addActivity: (event: ActivityEvent) => activity.push(event),
    } as unknown as Parameters<typeof resumeRateLimitedSession>[0]["store"],
  };
}

describe("resumeRateLimitedSession", () => {
  it("happy path: presses Enter once, records activity with system source and prefix", async () => {
    const { store, activity } = makeStore();
    const pressEnter = vi.fn(() => ({ ok: true }));
    const adapter = makeAdapter(() => ({ resetAt: "2026-05-26T10:00:00.000Z" }));
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "  rate-limit banner active...\n\n",
        pressEnter,
        getAdapter: () => adapter,
      },
      { sessionId: "sess_rl" },
    );
    expect(outcome).toEqual({ resumed: true, reason: "enter_sent" });
    expect(pressEnter).toHaveBeenCalledTimes(1);
    expect(pressEnter).toHaveBeenCalledWith("citadel_rl");
    expect(activity).toHaveLength(1);
    expect(activity[0]?.source).toBe("system");
    expect(activity[0]?.message.startsWith("[rate-limit-resumer]")).toBe(true);
    expect(activity[0]?.workspaceId).toBe("ws_1");
  });

  it("banner_gone: adapter returns null → does NOT press Enter, does NOT record activity", async () => {
    const { store, activity } = makeStore();
    const pressEnter = vi.fn(() => ({ ok: true }));
    const adapter = makeAdapter(() => null);
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "no banner here",
        pressEnter,
        getAdapter: () => adapter,
      },
      { sessionId: "sess_rl" },
    );
    expect(outcome).toEqual({ resumed: false, reason: "banner_gone" });
    expect(pressEnter).not.toHaveBeenCalled();
    expect(activity).toHaveLength(0);
  });

  it("input_in_progress: pane bottom line shows '❯ some text' → suppresses Enter", async () => {
    const { store, activity } = makeStore();
    const pressEnter = vi.fn(() => ({ ok: true }));
    const adapter = makeAdapter(() => ({ resetAt: null }));
    const pane = "rate limit banner\n\n❯ hello world\n";
    const outcome = await resumeRateLimitedSession(
      { store, paneCapture: () => pane, pressEnter, getAdapter: () => adapter },
      { sessionId: "sess_rl" },
    );
    expect(outcome).toEqual({ resumed: false, reason: "input_in_progress" });
    expect(pressEnter).not.toHaveBeenCalled();
    expect(activity).toHaveLength(0);
  });

  it("session_not_found: unknown id → error outcome", async () => {
    const { store } = makeStore();
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "",
        pressEnter: vi.fn(() => ({ ok: true })),
        getAdapter: () => makeAdapter(),
      },
      { sessionId: "sess_missing" },
    );
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toBe("session_not_found");
  });

  it("status not rate_limited → error outcome", async () => {
    const { store } = makeStore({ sessions: [makeSession({ status: "idle" })] });
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "banner",
        pressEnter: vi.fn(() => ({ ok: true })),
        getAdapter: () => makeAdapter(),
      },
      { sessionId: "sess_rl" },
    );
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toBe("session_not_rate_limited");
  });

  it("session has no tmux session → error outcome", async () => {
    const { store } = makeStore({ sessions: [makeSession({ tmuxSessionName: null })] });
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "banner",
        pressEnter: vi.fn(() => ({ ok: true })),
        getAdapter: () => makeAdapter(),
      },
      { sessionId: "sess_rl" },
    );
    expect(outcome.resumed).toBe(false);
    expect(outcome.reason).toBe("session_has_no_terminal");
  });

  it("pressEnter failure propagates the error", async () => {
    const { store, activity } = makeStore();
    const adapter = makeAdapter(() => ({ resetAt: null }));
    const outcome = await resumeRateLimitedSession(
      {
        store,
        paneCapture: () => "rate limit reached banner",
        pressEnter: () => ({ ok: false, error: "tmux_failed" }),
        getAdapter: () => adapter,
      },
      { sessionId: "sess_rl" },
    );
    expect(outcome).toEqual({ resumed: false, reason: "tmux_failed" });
    expect(activity).toHaveLength(0);
  });
});
