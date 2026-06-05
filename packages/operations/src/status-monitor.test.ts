import type { AgentSession } from "@citadel/contracts";
import type { RuntimeStatusAdapter } from "@citadel/runtimes";
import { REASON_ELAPSED_TIMER } from "@citadel/runtimes";
import { describe, expect, it, vi } from "vitest";
import { reduceStatus } from "./agent-status.js";
import { type MonitorTickDeps, type PaneCaptureOptions, runStatusMonitorTick } from "./status-monitor.js";

// Shell-first status monitor tests.
//
// Three regression-pin scenarios anchor the "tmux failure must not mass-flip
// every session to stopped" invariant. They live first in the file so a
// future refactor that re-introduces the legacy mass-flip path fails loud.

const FIXED_NOW = "2026-05-26T19:00:00.000Z";
const FIXED_NOW_MS = new Date(FIXED_NOW).valueOf();
const CODEX_REASON_CURRENT_TURN_DIVIDER = "pane:codex:current_turn_divider";
const CODEX_REASON_STABLE_TIMEOUT = "pane:codex:stable_timeout";
type DiagnosticEvent = { category: string; event: string; data?: Record<string, unknown> };

function makeSession(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_1",
    workspaceId: "ws_1",
    runtimeId: "claude-code",
    displayName: "test",
    status: "running",
    statusReason: null,
    statusReasonAt: null,
    lastStatusAt: "2026-05-26T18:59:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    terminalBackend: "tmux",
    tmuxSessionName: "citadel_test_1",
    tmuxSessionId: "$1",
    createdAt: "2026-05-26T18:59:00.000Z",
    updatedAt: "2026-05-26T18:59:00.000Z",
    ...over,
    kind: "agent",
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
  // Shell-first: deps gives `panePidProcess` (foreground command, null when
  // tmux missing) instead of legacy sentinel reads. Map keys are tmux
  // session names.
  panePidProcess?: Map<string, { command: string; pid: number } | null>;
  // Second-opinion has-session probe. Defaults to a stub that says every
  // session is missing, matching the legacy "no pane → dead" semantic
  // existing tests rely on.
  hasTmuxSession?: (name: string) => boolean;
  runtimeBinaries?: Map<string, string>;
  recentUserAction?: Map<string, number>;
  tmuxActivities?: Map<string, number>;
  paneCapture?: string | ((name: string, options?: PaneCaptureOptions) => string | Promise<string>);
  adapter?: RuntimeStatusAdapter;
  recoverRuntimeSessionId?: MonitorTickDeps["recoverRuntimeSessionId"];
  setRuntimeSessionId?: MonitorTickDeps["setRuntimeSessionId"];
  diagnosticsEvents?: DiagnosticEvent[];
  // Optional shared monitor state. When set, the deps uses this Map so
  // tests can observe / reuse state across multiple `runStatusMonitorTick`
  // calls (debounce tests need this).
  monitorStates?: Map<string, unknown>;
}

// Only used to give the test fixture's monitorStates Map a precise type
// (avoids `any` per repo biome rule).
function makeMonitorStateForFixture() {
  return {
    lastActivityMs: null as number | null,
    ticksSinceActivityChange: 0,
    hasObservedSinceBoot: false,
    consecutiveShellTicks: 0,
    consecutiveMissingTicks: 0,
  };
}

function makeDeps(over: DepsOver = {}) {
  const updates: Array<{ id: string; update: Record<string, unknown> }> = [];
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const deleted: string[] = [];
  const sessions = over.sessions ?? [makeSession()];
  const workspaces = over.workspaces ?? [{ id: "ws_1" }];
  const runtimeBinaries = over.runtimeBinaries ?? new Map([["claude-code", "claude"]]);
  const deps: MonitorTickDeps = {
    now: () => FIXED_NOW,
    listSessions: () => sessions,
    listWorkspaceIds: () => new Set(workspaces.map((w) => w.id)),
    updateSession: (id, update) => updates.push({ id, update: update as unknown as Record<string, unknown> }),
    deleteSession: (id) => deleted.push(id),
    emit: (event, payload) => emitted.push({ event, payload }),
    tmuxActivities: () => over.tmuxActivities ?? new Map(),
    paneCapture: (name, options) =>
      typeof over.paneCapture === "function" ? over.paneCapture(name, options) : (over.paneCapture ?? ""),
    // CRITICAL: must use `has()` not `??` — the Map may explicitly store
    // `null` for tmux-missing test cases, and `??` would treat that as
    // "no override" and fall back to the agent-foreground default.
    panePidProcess: (name) =>
      over.panePidProcess?.has(name) ? (over.panePidProcess.get(name) ?? null) : { command: "claude", pid: 1 },
    ...(over.hasTmuxSession ? { hasTmuxSession: over.hasTmuxSession } : {}),
    runtimeBinaryFor: (runtimeId) => runtimeBinaries.get(runtimeId) ?? null,
    ...(over.recoverRuntimeSessionId ? { recoverRuntimeSessionId: over.recoverRuntimeSessionId } : {}),
    ...(over.setRuntimeSessionId ? { setRuntimeSessionId: over.setRuntimeSessionId } : {}),
    ...(over.diagnosticsEvents
      ? {
          diagnostics: {
            log: (category: string, event: string, data?: Record<string, unknown>) => {
              over.diagnosticsEvents?.push(data === undefined ? { category, event } : { category, event, data });
            },
          },
        }
      : {}),
    recentUserAction: over.recentUserAction ?? new Map(),
    getAdapter: () => over.adapter ?? makeAdapter(null),
    adapterStates: new Map(),
    monitorStates: (over.monitorStates ?? new Map()) as Map<string, ReturnType<typeof makeMonitorStateForFixture>>,
  };
  return { deps, updates, emitted, deleted };
}

describe("regression-pin: tmux failure MUST NOT mass-flip sessions to stopped", () => {
  it("(scenario 1) panePidProcess returning null for every session marks them `unknown` after the 3-tick debounce, never `stopped`", async () => {
    // Simulate tmux being entirely unreachable — every panePidProcess() lookup
    // returns null. Mirrors the 18:40:57 production incident at the
    // status-monitor tick layer. With the 3-strike rule the first two ticks
    // are no-ops (durable absence isn't yet proven); the third tick is when
    // the flip lands. Anything below 3 means a 50ms tmux hiccup could wipe
    // every cockpit terminal (the 2026-05-28 05:49 incident).
    const sessions = Array.from({ length: 25 }, (_, i) =>
      makeSession({ id: `sess_${i}`, tmuxSessionName: `citadel_${i}` }),
    );
    const panePidProcess = new Map<string, { command: string; pid: number } | null>();
    for (const s of sessions) panePidProcess.set(s.tmuxSessionName ?? "", null);
    const monitorStates = new Map<string, unknown>();
    const { deps, updates } = makeDeps({ sessions, panePidProcess, monitorStates });
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(0);
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(0);
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.update.status).toBe("unknown");
      expect(u.update.status).not.toBe("stopped");
      expect(u.update.status).not.toBe("failed");
    }
  });

  it("(scenario 1b) a single null probe followed by a found pane resets the counter and never flips", async () => {
    // Models the 05:49 failure mode: list-panes errors on one tick, returns
    // normal output on the next. With the 3-strike rule a single missing
    // observation never flips — and once pane is seen again the counter
    // resets, so even an unlucky sequence (miss, miss, alive, miss, miss)
    // can't trip the flip.
    const sessions = [makeSession({ id: "sess_1", tmuxSessionName: "citadel_1" })];
    const monitorStates = new Map<string, unknown>();
    // Tick 1: pane missing
    let panePidProcess = new Map<string, { command: string; pid: number } | null>([["citadel_1", null]]);
    let fixture = makeDeps({ sessions, panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.updates).toHaveLength(0);
    // Tick 2: pane back (claude foreground) — counter resets, no flip.
    panePidProcess = new Map([["citadel_1", { command: "claude", pid: 100 }]]);
    fixture = makeDeps({ sessions, panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.updates).toHaveLength(0);
    // Ticks 3-4: pane missing again, still no flip (counter resumes from 0).
    panePidProcess = new Map([["citadel_1", null]]);
    fixture = makeDeps({ sessions, panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.updates).toHaveLength(0);
    fixture = makeDeps({ sessions, panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.updates).toHaveLength(0);
  });

  it("(scenario 1c) has-session second opinion returning true keeps the session alive even when panePidProcess is null", async () => {
    // The defining failure mode: batched `tmux list-panes -a` errored and
    // returned an empty Map, but `tmux has-session -t <name>` still works.
    // The tick must trust has-session and skip the flip.
    const sessions = [makeSession({ id: "sess_1", tmuxSessionName: "citadel_1" })];
    const panePidProcess = new Map<string, { command: string; pid: number } | null>([["citadel_1", null]]);
    const { deps, updates } = makeDeps({
      sessions,
      panePidProcess,
      hasTmuxSession: (name) => name === "citadel_1",
    });
    // Tick repeatedly — even past the debounce — and assert no flip.
    for (let i = 0; i < 5; i++) {
      await runStatusMonitorTick(deps, { source: "tick" });
    }
    expect(updates).toHaveLength(0);
  });

  it("(scenario 1d) tmux-missing diagnostics fire once at the debounce threshold, not every later tick", async () => {
    const diagnosticsEvents: DiagnosticEvent[] = [];
    const sessions = [makeSession({ id: "sess_diag", tmuxSessionName: "citadel_diag" })];
    const panePidProcess = new Map<string, { command: string; pid: number } | null>([["citadel_diag", null]]);
    const monitorStates = new Map<string, unknown>();
    const { deps } = makeDeps({ sessions, panePidProcess, monitorStates, diagnosticsEvents });

    for (let i = 0; i < 6; i++) {
      await runStatusMonitorTick(deps, { source: "tick" });
    }

    expect(diagnosticsEvents.filter((event) => event.event === "missing-counter.bump")).toHaveLength(2);
    const fired = diagnosticsEvents.filter((event) => event.event === "tmux-missing.fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]?.data).toMatchObject({ sessionId: "sess_diag", count: 3, threshold: 3 });
  });

  it("(scenario 1e) already-unknown tmux-missing rows do not keep emitting missing diagnostics", async () => {
    const diagnosticsEvents: DiagnosticEvent[] = [];
    const sessions = [
      makeSession({
        id: "sess_unknown_diag",
        tmuxSessionName: "citadel_unknown_diag",
        status: "unknown",
        statusReason: "tmux_missing",
      }),
    ];
    const panePidProcess = new Map<string, { command: string; pid: number } | null>([["citadel_unknown_diag", null]]);
    const monitorStates = new Map<string, unknown>();
    const { deps } = makeDeps({ sessions, panePidProcess, monitorStates, diagnosticsEvents });

    for (let i = 0; i < 6; i++) {
      await runStatusMonitorTick(deps, { source: "tick" });
    }

    expect(diagnosticsEvents.filter((event) => event.event.startsWith("missing-counter"))).toHaveLength(0);
    expect(diagnosticsEvents.filter((event) => event.event === "tmux-missing.fired")).toHaveLength(0);
  });

  it("(scenario 2) legacy /tmp/citadel-agent-*.exit files on disk MUST NOT influence the tick — readSentinels was removed from MonitorTickDeps", () => {
    // Compile-time pin: importing the deps type and asserting it has no
    // `readSentinels` member. (TypeScript would have flagged this in CI, but
    // the explicit assertion documents the invariant for future readers.)
    const dummyDeps = makeDeps().deps;
    expect("readSentinels" in dummyDeps).toBe(false);
  });

  it("(scenario 3) idle agents whose foreground is bash for one tick do NOT flip to idle — two-tick debounce prevents claude→git→claude flicker", async () => {
    const { deps, updates } = makeDeps({
      sessions: [makeSession()],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
    });
    // One tick observing bash should NOT produce an update — debounce requires 2.
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(0);
  });
});

describe("shell-first per-runtime status derivation", () => {
  it("claude-code foreground → keeps status running", async () => {
    const { deps, updates } = makeDeps({
      panePidProcess: new Map([["citadel_test_1", { command: "claude", pid: 100 }]]),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    // No state change → no update.
    expect(updates).toHaveLength(0);
  });

  it("shell-like custom agent runtime with shell foreground stays running", async () => {
    const { deps, updates } = makeDeps({
      sessions: [makeSession({ id: "sess_term", runtimeId: "test-agent" })],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
      runtimeBinaries: new Map([["test-agent", "bash"]]),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    // A shell-like custom agent runtime should not flip to idle when foreground is bash.
    expect(updates).toHaveLength(0);
  });

  it("agent runtime: two consecutive ticks of shell foreground flips to idle with idle_after_unexpected_exit label", async () => {
    const monitorStates = new Map();
    const { deps, updates } = makeDeps({
      sessions: [makeSession()],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
      monitorStates,
    });
    await runStatusMonitorTick(deps, { source: "tick" }); // first tick: debounce
    expect(updates).toHaveLength(0);
    await runStatusMonitorTick(deps, { source: "tick" }); // second tick: flip
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({
      status: "idle",
      reason: "idle_after_unexpected_exit",
    });
    expect(updates[0]?.update.reasonAt).toBeDefined();
  });

  it("agent runtime: running → idle WITH recent user action clears statusReason to null (no attention label)", async () => {
    const recentUserAction = new Map([["sess_1", FIXED_NOW_MS - 1000]]); // 1s ago, within 5s window
    const monitorStates = new Map();
    const { deps, updates } = makeDeps({
      sessions: [makeSession()],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
      recentUserAction,
      monitorStates,
    });
    await runStatusMonitorTick(deps, { source: "tick" }); // debounce
    await runStatusMonitorTick(deps, { source: "tick" }); // flip
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({ status: "idle", reason: null, reasonAt: null });
  });

  it("agent runtime: an advancing visible timer beats shell-foreground idle detection", async () => {
    const monitorStates = new Map();
    let captureTick = 0;
    const { deps, updates } = makeDeps({
      sessions: [makeSession({ runtimeId: "codex", statusReason: null })],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      paneCapture: () => {
        captureTick += 1;
        return `output\n◦ Working (${10 + captureTick}s)\n  gpt-5.5 default · ~/wherever`;
      },
      monitorStates,
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({ status: "running", reason: REASON_ELAPSED_TIMER });
    expect(updates[0]?.update.status).not.toBe("idle");
  });

  it("awaits async pane capture before runtime adapter observation", async () => {
    const adapter: RuntimeStatusAdapter = {
      runtimeId: "claude-code",
      createSessionState: () => ({ ticksObserved: 0, lastPaneHash: null }),
      observe: vi.fn((_state, ctx) => (ctx.paneCapture.includes("async-ready") ? "waiting_for_input" : null)),
    };
    const { deps, updates } = makeDeps({
      paneCapture: async () => "async-ready",
      adapter,
    });

    await runStatusMonitorTick(deps, { source: "tick" });

    expect(adapter.observe).toHaveBeenCalled();
    expect(updates[0]?.update).toMatchObject({ status: "waiting_for_input" });
  });
});

describe("pane capture freshness policy", () => {
  it("asks for a very fresh Codex pane capture while the DB row is post-turn idle", async () => {
    const captureOptions: PaneCaptureOptions[] = [];
    const { deps } = makeDeps({
      sessions: [makeSession({ runtimeId: "codex", status: "idle" })],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      paneCapture: (_name, options) => {
        captureOptions.push(options ?? {});
        return "idle pane";
      },
    });

    await runStatusMonitorTick(deps, { source: "tick" });

    expect(captureOptions[0]?.maxAgeMs).toBe(1000);
  });

  it("bounds Codex running-state capture staleness without forcing every global pane capture", async () => {
    const captureOptions: PaneCaptureOptions[] = [];
    const { deps } = makeDeps({
      sessions: [makeSession({ runtimeId: "codex", status: "running" })],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      paneCapture: (_name, options) => {
        captureOptions.push(options ?? {});
        return "running pane";
      },
    });

    await runStatusMonitorTick(deps, { source: "tick" });

    expect(captureOptions[0]?.maxAgeMs).toBe(10_000);
  });
});

describe("codex optimistic-send idle suppression", () => {
  it("suppresses weak stable-timeout idle immediately after optimistic_send", async () => {
    const { deps, updates } = makeDeps({
      sessions: [
        makeSession({
          runtimeId: "codex",
          status: "running",
          statusReason: "optimistic_send",
          lastStatusAt: "2026-05-26T18:59:55.000Z",
        }),
      ],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      adapter: makeAdapter({ observed: "idle", reason: CODEX_REASON_STABLE_TIMEOUT }),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(0);
  });

  it("allows positive current-turn divider idle even inside the optimistic_send window", async () => {
    const { deps, updates } = makeDeps({
      sessions: [
        makeSession({
          runtimeId: "codex",
          status: "running",
          statusReason: "optimistic_send",
          lastStatusAt: "2026-05-26T18:59:55.000Z",
        }),
      ],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      adapter: makeAdapter({ observed: "idle", reason: CODEX_REASON_CURRENT_TURN_DIVIDER }),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({
      status: "idle",
      reason: CODEX_REASON_CURRENT_TURN_DIVIDER,
    });
  });

  it("allows stable-timeout idle after the optimistic_send grace window expires", async () => {
    const { deps, updates } = makeDeps({
      sessions: [
        makeSession({
          runtimeId: "codex",
          status: "running",
          statusReason: "optimistic_send",
          lastStatusAt: "2026-05-26T18:59:00.000Z",
        }),
      ],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      adapter: makeAdapter({ observed: "idle", reason: CODEX_REASON_STABLE_TIMEOUT }),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update).toMatchObject({
      status: "idle",
      reason: CODEX_REASON_STABLE_TIMEOUT,
    });
  });
});

describe("runtime session id repair", () => {
  it("backfills a missing runtimeSessionId for a live codex pane", async () => {
    const setCalls: Array<{ sessionId: string; runtimeSessionId: string }> = [];
    const session = makeSession({
      id: "sess_codex",
      runtimeId: "codex",
      runtimeSessionId: null,
    });
    const { deps, emitted } = makeDeps({
      sessions: [session],
      panePidProcess: new Map([["citadel_test_1", { command: "codex", pid: 100 }]]),
      runtimeBinaries: new Map([["codex", "codex"]]),
      recoverRuntimeSessionId: (candidate, pane) =>
        candidate.id === "sess_codex" && pane?.pid === 100 ? "019e6fb1-4632-7492-b175-cd9de9afb5bf" : null,
      setRuntimeSessionId: (sessionId, runtimeSessionId) => setCalls.push({ sessionId, runtimeSessionId }),
    });
    const result = await runStatusMonitorTick(deps, { source: "tick" });

    expect(setCalls).toEqual([{ sessionId: "sess_codex", runtimeSessionId: "019e6fb1-4632-7492-b175-cd9de9afb5bf" }]);
    expect(emitted).toContainEqual({
      event: "agent.updated",
      payload: { workspaceId: "ws_1", sessionId: "sess_codex" },
    });
    expect(result.sessionsTouched).toBe(1);
  });
});

describe("30-minute auto-clear of idle_after_unexpected_exit", () => {
  it("clears reason + reasonAt when statusReasonAt is older than the window", async () => {
    const longAgo = new Date(FIXED_NOW_MS - 31 * 60 * 1000).toISOString();
    const session = makeSession({
      status: "idle",
      statusReason: "idle_after_unexpected_exit",
      statusReasonAt: longAgo,
    });
    const { deps, updates } = makeDeps({
      sessions: [session],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    // Auto-clear update.
    const cleared = updates.find((u) => u.update.reason === null);
    expect(cleared).toBeDefined();
    expect(cleared?.update.reasonAt).toBeNull();
  });

  it("does NOT clear within the 30-min window", async () => {
    const recent = new Date(FIXED_NOW_MS - 10 * 60 * 1000).toISOString(); // 10 min ago
    const session = makeSession({
      status: "idle",
      statusReason: "idle_after_unexpected_exit",
      statusReasonAt: recent,
    });
    const { deps, updates } = makeDeps({
      sessions: [session],
      panePidProcess: new Map([["citadel_test_1", { command: "bash", pid: 100 }]]),
    });
    await runStatusMonitorTick(deps, { source: "tick" });
    // No clear update.
    expect(updates.find((u) => u.update.reason === null)).toBeUndefined();
  });
});

describe("launch_failed reducer signal still produces status='failed'", () => {
  it("pins the reducer path that flows from createAgentSession when tmux new-session itself errors", () => {
    // The status monitor doesn't emit launch_failed, but the reducer must
    // still translate it correctly for direct callers (create-agent-session
    // on tmux-spawn failure). This pins the reducer behaviour so the §5
    // cleanup didn't accidentally trim the branch.
    const prev = { status: "starting" as const, lastOutputAt: null, statusReason: null };
    const update = reduceStatus(prev, { type: "launch_failed", reason: "spawn_failed" }, () => FIXED_NOW);
    expect(update?.status).toBe("failed");
    expect(update?.reason).toBe("spawn_failed");
    expect(update?.endedAt).toBe(FIXED_NOW);
  });
});

describe("workspace-membership cleanup (existing behaviour preserved)", () => {
  it("deletes session when tmux is missing AND the workspace is gone — only after the missing-tick debounce", async () => {
    // Same 3-strike rule as the flip-to-unknown path: deletion is irreversible
    // so we must not act on a single failed probe. Workspace-gone tightens the
    // gate (the session is doubly orphaned) but doesn't change the cadence.
    const monitorStates = new Map<string, unknown>();
    const sessions = [makeSession({ workspaceId: "ws_gone" })];
    const panePidProcess = new Map<string, { command: string; pid: number } | null>([["citadel_test_1", null]]);
    let fixture = makeDeps({ sessions, workspaces: [], panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.deleted).toHaveLength(0);
    fixture = makeDeps({ sessions, workspaces: [], panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.deleted).toHaveLength(0);
    fixture = makeDeps({ sessions, workspaces: [], panePidProcess, monitorStates });
    await runStatusMonitorTick(fixture.deps, { source: "tick" });
    expect(fixture.deleted).toEqual(["sess_1"]);
  });
});
