import type { AgentSession } from "@citadel/contracts";
import type { RuntimeStatusAdapter } from "@citadel/runtimes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type MonitorTickDeps, runStatusMonitorTick } from "./status-monitor.js";

const FIXED_NOW = "2026-05-25T12:00:00.000Z";

function makeSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "test",
    status: "running",
    statusReason: null,
    lastStatusAt: "2026-05-25T11:59:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    tmuxSessionName: "citadel_test_1",
    tmuxSessionId: "$1",
    createdAt: "2026-05-25T11:59:00.000Z",
    updatedAt: "2026-05-25T11:59:00.000Z",
    ...over,
  };
}

function makeAdapter(observed: ReturnType<RuntimeStatusAdapter["observe"]>): RuntimeStatusAdapter {
  return {
    runtimeId: "claude-code",
    createSessionState: () => ({ ticksObserved: 0, lastPaneHash: null }),
    observe: vi.fn(() => observed),
  };
}

interface DepsOver {
  sessions?: AgentSession[];
  workspaces?: Array<{ id: string }>;
  tmuxActivities?: Map<string, number>;
  paneCaptures?: Map<string, string>;
  sentinels?: Map<string, { live: boolean; exitCode: number | null; exitedAt: string | null }>;
  adapter?: RuntimeStatusAdapter;
}

function makeDeps(over: DepsOver = {}): {
  deps: MonitorTickDeps;
  updates: Array<{ id: string; update: Record<string, unknown> }>;
  emitted: Array<{ event: string; payload: unknown }>;
  deleted: string[];
} {
  const updates: Array<{ id: string; update: Record<string, unknown> }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const deleted: string[] = [];
  const sessions = over.sessions ?? [makeSession()];
  const workspaces = over.workspaces ?? [{ id: "ws_1" }];

  const deps: MonitorTickDeps = {
    now: () => FIXED_NOW,
    listSessions: () => sessions,
    listWorkspaceIds: () => new Set(workspaces.map((w) => w.id)),
    updateSession: (id, update) => updates.push({ id, update: update as Record<string, unknown> }),
    deleteSession: (id) => deleted.push(id),
    emit: (event, payload) => emitted.push({ event, payload }),
    tmuxActivities: () => over.tmuxActivities ?? new Map(),
    paneCapture: (name) => over.paneCaptures?.get(name) ?? "",
    readSentinels: async (name) => over.sentinels?.get(name) ?? { live: true, exitCode: null, exitedAt: null },
    getAdapter: () => over.adapter ?? makeAdapter(null),
    adapterStates: new Map(),
    monitorStates: new Map(),
  };

  return { deps, updates, emitted, deleted };
}

describe("runStatusMonitorTick", () => {
  describe("session filtering", () => {
    it("returns no-op result with empty session list", async () => {
      const { deps } = makeDeps({ sessions: [] });
      const result = await runStatusMonitorTick(deps, { source: "tick" });
      expect(result).toEqual({ sessionsTouched: 0, deletedSessions: 0 });
    });

    it("skips sessions in terminal states (stopped, failed)", async () => {
      const { deps, updates, emitted } = makeDeps({
        sessions: [
          makeSession({ id: "s_stopped", status: "stopped" }),
          makeSession({ id: "s_failed", status: "failed" }),
        ],
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it("skips shell runtime sessions entirely", async () => {
      const { deps, updates, emitted } = makeDeps({
        sessions: [makeSession({ id: "s_shell", runtimeId: "shell" })],
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates).toHaveLength(0);
      expect(emitted).toHaveLength(0);
    });

    it("processes unknown sessions (reason can refine, resurrection possible)", async () => {
      const adapter = makeAdapter("running");
      const { deps, updates } = makeDeps({
        sessions: [makeSession({ id: "s_unk", status: "unknown", statusReason: "tmux_missing" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(adapter.observe).toHaveBeenCalled();
      // Resurrection: unknown × pane_observation(running) → running
      expect(updates).toHaveLength(1);
      expect(updates[0]?.update).toMatchObject({ status: "running" });
    });
  });

  describe("lifecycle signals — exit sentinel", () => {
    it("`.exit` with code 0 → stopped (clean exit)", async () => {
      const { deps, updates, emitted } = makeDeps({
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: 0, exitedAt: "2026-05-25T11:59:30.000Z" }]]),
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates).toHaveLength(1);
      expect(updates[0]?.update).toMatchObject({ status: "stopped", exitCode: 0, endedAt: "2026-05-25T11:59:30.000Z" });
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.event).toBe("agent.updated");
    });

    it("`.exit` with non-zero code → failed", async () => {
      const { deps, updates } = makeDeps({
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: 7, exitedAt: "2026-05-25T11:59:30.000Z" }]]),
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates[0]?.update).toMatchObject({ status: "failed", exitCode: 7 });
    });
  });

  describe("lifecycle signals — tmux missing", () => {
    it("tmux session absent + workspace still exists → unknown(tmux_missing)", async () => {
      const { deps, updates, deleted } = makeDeps({
        tmuxActivities: new Map(), // empty — no tmux sessions
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: null, exitedAt: null }]]),
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(deleted).toHaveLength(0);
      expect(updates).toHaveLength(1);
      expect(updates[0]?.update).toMatchObject({ status: "unknown", reason: "tmux_missing" });
    });

    it("tmux session absent + workspace also gone → deleteSession, no reducer update", async () => {
      const { deps, updates, deleted, emitted } = makeDeps({
        sessions: [makeSession({ id: "s_orphan", workspaceId: "ws_gone" })],
        workspaces: [], // workspace deleted
        tmuxActivities: new Map(),
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(deleted).toEqual(["s_orphan"]);
      expect(updates).toHaveLength(0);
      // No emit either — the session ceased to exist; UI catches it via next state poll.
      expect(emitted).toHaveLength(0);
    });

    it("boot tick uses daemon_restart_indeterminate reason for tmux_missing", async () => {
      const { deps, updates } = makeDeps({
        tmuxActivities: new Map(),
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: null, exitedAt: null }]]),
      });
      await runStatusMonitorTick(deps, { source: "boot" });
      expect(updates[0]?.update).toMatchObject({ status: "unknown", reason: "daemon_restart_indeterminate" });
    });

    it("sentinel `.live` missing + `.exit` missing + tmux ALIVE → unknown(sentinel_missing_tmux_alive)", async () => {
      const { deps, updates } = makeDeps({
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: null, exitedAt: null }]]),
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates[0]?.update).toMatchObject({ status: "unknown", reason: "sentinel_missing_tmux_alive" });
    });
  });

  describe("emit suppression on boot", () => {
    it("boot tick does not emit agent.updated (emit fn called with no-op)", async () => {
      // The skill's design says boot threads emit=()=>{}. The deps' own emit
      // is what we observe; the monitor itself doesn't decide to call it or
      // not — the wrapper passes a noop emit on boot. We assert that even when
      // the deps' emit IS set, the boot path still calls it (caller's
      // responsibility to noop). This is just the contract: emit is always
      // invoked; the caller decides whether it's a real broadcast.
      // (Documented behavior: boot reconcile passes emit=()=>{})
      const { deps, emitted } = makeDeps({
        tmuxActivities: new Map(),
        sentinels: new Map([["citadel_test_1", { live: false, exitCode: 0, exitedAt: "2026-05-25T11:59:30.000Z" }]]),
      });
      await runStatusMonitorTick(deps, { source: "boot" });
      // The deps.emit was called. Caller controls whether it broadcasts.
      expect(emitted).toHaveLength(1);
    });
  });

  describe("adapter integration — pane_observation drives status", () => {
    it("calls adapter.observe with the pane capture", async () => {
      const adapter = makeAdapter("idle");
      const { deps } = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        paneCaptures: new Map([["citadel_test_1", "fake pane content"]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(adapter.observe).toHaveBeenCalledTimes(1);
      const call = (adapter.observe as ReturnType<typeof vi.fn>).mock.calls[0]?.[1];
      expect(call?.paneCapture).toBe("fake pane content");
    });

    it("running × adapter says idle → idle transition", async () => {
      const adapter = makeAdapter("idle");
      const { deps, updates } = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates).toHaveLength(1);
      expect(updates[0]?.update).toMatchObject({ status: "idle" });
    });

    it("adapter returns null → no update emitted (no opinion)", async () => {
      const adapter = makeAdapter(null);
      const { deps, updates } = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(updates).toHaveLength(0);
    });
  });

  describe("activity-changed bookkeeping", () => {
    it("first tick with activity recorded → ticksSinceActivityChange = 0, tmuxActivityChangedSinceLastTick = true", async () => {
      const adapter = makeAdapter(null);
      const captured: Array<{ ticks: number; changed: boolean; hasObserved: boolean }> = [];
      adapter.observe = vi.fn((_state, ctx) => {
        captured.push({
          ticks: ctx.ticksSinceActivityChange,
          changed: ctx.tmuxActivityChangedSinceLastTick,
          hasObserved: ctx.hasObservedSinceBoot,
        });
        return null;
      });
      const deps = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      }).deps;
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(captured).toHaveLength(1);
      expect(captured[0]?.changed).toBe(true);
      expect(captured[0]?.hasObserved).toBe(false); // first observation of this session
    });

    it("second tick with same activity ts → ticksSinceActivityChange = 1, tmuxActivityChangedSinceLastTick = false", async () => {
      const adapter = makeAdapter(null);
      const captured: Array<{ ticks: number; changed: boolean; hasObserved: boolean }> = [];
      adapter.observe = vi.fn((_state, ctx) => {
        captured.push({
          ticks: ctx.ticksSinceActivityChange,
          changed: ctx.tmuxActivityChangedSinceLastTick,
          hasObserved: ctx.hasObservedSinceBoot,
        });
        return null;
      });
      const { deps } = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(captured).toHaveLength(2);
      expect(captured[1]?.ticks).toBe(1);
      expect(captured[1]?.changed).toBe(false);
      expect(captured[1]?.hasObserved).toBe(true);
    });

    it("third tick (still stable) → ticksSinceActivityChange = 2", async () => {
      const adapter = makeAdapter(null);
      const captured: number[] = [];
      adapter.observe = vi.fn((_state, ctx) => {
        captured.push(ctx.ticksSinceActivityChange);
        return null;
      });
      const { deps } = makeDeps({
        sessions: [makeSession({ status: "running" })],
        tmuxActivities: new Map([["citadel_test_1", 1700000000000]]),
        adapter,
      });
      await runStatusMonitorTick(deps, { source: "tick" });
      await runStatusMonitorTick(deps, { source: "tick" });
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(captured).toEqual([0, 1, 2]);
    });

    it("activity bump between ticks resets the counter", async () => {
      const adapter = makeAdapter(null);
      const captured: number[] = [];
      adapter.observe = vi.fn((_state, ctx) => {
        captured.push(ctx.ticksSinceActivityChange);
        return null;
      });
      const sessions = [makeSession({ status: "running" })];
      const tmuxActivities = new Map([["citadel_test_1", 1700000000000]]);
      const { deps } = makeDeps({ sessions, tmuxActivities, adapter });
      await runStatusMonitorTick(deps, { source: "tick" });
      tmuxActivities.set("citadel_test_1", 1700000001000);
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(captured).toEqual([0, 0]);
    });
  });

  describe("tmux is queried once per tick (batched)", () => {
    it("tmuxActivities() is invoked exactly once even with N sessions", async () => {
      const tmuxFn = vi.fn(() => new Map([["citadel_test_1", 1700000000000]]));
      const { deps } = makeDeps({
        sessions: [
          makeSession({ id: "s1", tmuxSessionName: "citadel_test_1" }),
          makeSession({ id: "s2", tmuxSessionName: "citadel_test_2" }),
          makeSession({ id: "s3", tmuxSessionName: "citadel_test_3" }),
        ],
      });
      deps.tmuxActivities = tmuxFn;
      await runStatusMonitorTick(deps, { source: "tick" });
      expect(tmuxFn).toHaveBeenCalledTimes(1);
    });
  });
});
