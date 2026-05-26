import type { AgentSession, BackgroundAgentSession, RateLimitResumption } from "@citadel/contracts";
import { describe, expect, it, vi } from "vitest";
import { runRateLimitSchedulerTick } from "./rate-limit-scheduler.js";
import type { MonitorSessionState } from "./status-monitor.js";

function rlSession(over: Partial<AgentSession> = {}): AgentSession {
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

function monitorState(over: Partial<MonitorSessionState> = {}): MonitorSessionState {
  return {
    lastActivityMs: null,
    ticksSinceActivityChange: 0,
    hasObservedSinceBoot: true,
    consecutiveNonRateLimitedTicks: 0,
    hasCompletedFirstTick: true,
    ...over,
  };
}

type FakeStore = {
  sessions: AgentSession[];
  rows: RateLimitResumption[];
  background: BackgroundAgentSession[];
  activities: number;
};

function makeStore(input: Partial<FakeStore> = {}) {
  const data: FakeStore = {
    sessions: input.sessions ?? [],
    rows: input.rows ?? [],
    background: input.background ?? [],
    activities: 0,
  };
  return {
    data,
    store: {
      listSessions: () => data.sessions,
      listRunningBackgroundSessions: () => data.background,
      findPendingRateLimitResumption: () => data.rows.find((r) => r.status === "pending") ?? null,
      listDueRateLimitResumptions: (now: string) =>
        data.rows.filter((r) => r.status === "pending" && r.scheduledAt <= now),
      insertRateLimitResumption: (row: RateLimitResumption) => {
        const existing = data.rows.find((r) => r.status === "pending");
        if (existing) return existing;
        data.rows.push(row);
        return row;
      },
      markRateLimitResumptionExecuted: (id: string, executedAt: string) => {
        const row = data.rows.find((r) => r.id === id);
        if (!row) return null;
        row.status = "executed";
        row.executedAt = executedAt;
        return row;
      },
    } as unknown as Parameters<typeof runRateLimitSchedulerTick>[0]["store"],
  };
}

const T_NOW = "2026-05-26T10:00:30.000Z"; // 30 s past the reset stored in rlSession default

describe("runRateLimitSchedulerTick — schedule phase", () => {
  it("no rate_limited sessions → no row inserted", async () => {
    const { store, data } = makeStore();
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: new Map(),
      resumeSession: vi.fn(),
      emit: vi.fn(),
    });
    expect(result.scheduled).toBe(false);
    expect(data.rows).toHaveLength(0);
  });

  it("rate_limited candidate without first-tick gate → NOT scheduled", async () => {
    const session = rlSession();
    const { store, data } = makeStore({ sessions: [session] });
    const states = new Map([[session.id, monitorState({ hasCompletedFirstTick: false })]]);
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession: vi.fn(),
      emit: vi.fn(),
    });
    expect(result.scheduled).toBe(false);
    expect(data.rows).toHaveLength(0);
  });

  it("rate_limited with known reset + first-tick complete → schedule at max(now+60s, reset+60s)", async () => {
    const session = rlSession({ statusReason: "rate_limited:2026-05-26T11:00:00.000Z" });
    const { store, data } = makeStore({ sessions: [session] });
    const states = new Map([[session.id, monitorState()]]);
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession: vi.fn(),
      emit: vi.fn(),
    });
    expect(result.scheduled).toBe(true);
    expect(data.rows).toHaveLength(1);
    // reset+60s wins because reset (11:00) is in the future relative to now (10:00:30).
    expect(data.rows[0]?.scheduledAt).toBe("2026-05-26T11:01:00.000Z");
  });

  it("already pending row → second candidate does NOT insert another", async () => {
    const session1 = rlSession();
    const session2 = rlSession({ id: "sess_rl_2", statusReason: "rate_limited:2026-05-26T12:00:00.000Z" });
    const existing: RateLimitResumption = {
      id: "rlr_existing",
      scheduledAt: "2026-05-26T10:30:00.000Z",
      status: "pending",
      createdAt: "2026-05-26T10:00:00.000Z",
      executedAt: null,
    };
    const { store, data } = makeStore({
      sessions: [session1, session2],
      rows: [existing],
    });
    const states = new Map([
      [session1.id, monitorState()],
      [session2.id, monitorState()],
    ]);
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession: vi.fn(),
      emit: vi.fn(),
    });
    expect(result.scheduled).toBe(false);
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.id).toBe("rlr_existing");
  });

  it("all candidates have unknown_reset → no row inserted", async () => {
    const session = rlSession({ statusReason: "rate_limited:unknown_reset" });
    const { store, data } = makeStore({ sessions: [session] });
    const states = new Map([[session.id, monitorState()]]);
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession: vi.fn(),
      emit: vi.fn(),
    });
    expect(result.scheduled).toBe(false);
    expect(data.rows).toHaveLength(0);
  });
});

describe("runRateLimitSchedulerTick — execute phase", () => {
  it("due row fans out to candidates whose reset has passed; future-reset sessions skipped", async () => {
    const pastSession = rlSession({ id: "sess_past", statusReason: "rate_limited:2026-05-26T10:00:00.000Z" });
    const futureSession = rlSession({
      id: "sess_future",
      statusReason: "rate_limited:2026-05-26T11:00:00.000Z",
      tmuxSessionName: "citadel_future",
    });
    const dueRow: RateLimitResumption = {
      id: "rlr_due",
      scheduledAt: "2026-05-26T10:00:30.000Z",
      status: "pending",
      createdAt: "2026-05-26T09:30:00.000Z",
      executedAt: null,
    };
    const { store, data } = makeStore({
      sessions: [pastSession, futureSession],
      rows: [dueRow],
    });
    const states = new Map([
      [pastSession.id, monitorState()],
      [futureSession.id, monitorState()],
    ]);
    const resumed: string[] = [];
    const resumeSession = vi.fn(async (sessionId: string) => {
      resumed.push(sessionId);
      return { resumed: true, reason: "enter_sent" };
    });
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const emit = (event: string, payload: unknown) => emitted.push({ event, payload });
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession,
      emit,
    });
    expect(resumed).toEqual(["sess_past"]); // future-reset skipped
    expect(result.executed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(data.rows[0]?.status).toBe("executed");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.event).toBe("rate-limit.resumed");
  });

  it("background scheduled-agent sessions are excluded from resume", async () => {
    const session = rlSession({ statusReason: "rate_limited:2026-05-26T10:00:00.000Z" });
    const dueRow: RateLimitResumption = {
      id: "rlr_due",
      scheduledAt: "2026-05-26T10:00:30.000Z",
      status: "pending",
      createdAt: "2026-05-26T09:30:00.000Z",
      executedAt: null,
    };
    const background: BackgroundAgentSession = {
      id: "bg_1",
      scheduledAgentId: "sched_1",
      cwd: "/tmp/bg",
      logFilePath: "/tmp/bg.log",
      tmuxSessionName: session.tmuxSessionName ?? "",
      tmuxSessionId: "$3",
      status: "running",
      createdAt: "",
      updatedAt: "",
    };
    const { store } = makeStore({ sessions: [session], rows: [dueRow], background: [background] });
    const states = new Map([[session.id, monitorState()]]);
    const resumeSession = vi.fn(async () => ({ resumed: true, reason: "enter_sent" }));
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession,
      emit: vi.fn(),
    });
    expect(resumeSession).not.toHaveBeenCalled();
    expect(result.executed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("first post-boot tick (hasCompletedFirstTick=false) skips a due row in execute phase", async () => {
    const session = rlSession();
    const dueRow: RateLimitResumption = {
      id: "rlr_stale",
      scheduledAt: "2026-05-26T10:00:30.000Z",
      status: "pending",
      createdAt: "2026-05-26T09:30:00.000Z",
      executedAt: null,
    };
    const { store, data } = makeStore({ sessions: [session], rows: [dueRow] });
    const states = new Map([[session.id, monitorState({ hasCompletedFirstTick: false })]]);
    const resumeSession = vi.fn(async () => ({ resumed: true, reason: "enter_sent" }));
    const result = await runRateLimitSchedulerTick({
      store,
      now: () => T_NOW,
      monitorStates: states,
      resumeSession,
      emit: vi.fn(),
    });
    expect(resumeSession).not.toHaveBeenCalled();
    // The row was due but no candidates qualified → marked executed (no work to do)
    // and emitted.
    expect(data.rows[0]?.status).toBe("executed");
    expect(result.executed).toBe(0);
  });
});
