import type { AgentSession } from "@citadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendMessageResult } from "./agent-messages.js";
import {
  type AutoResumeDeps,
  BASE_DELAY_MS,
  JITTER_MS,
  MAX_DELAY_MS,
  RESUME_PROMPTS,
  computeNextDelayMs,
  pickResumePrompt,
  runAutoResumeTick,
  startAutoResumeLoop,
} from "./auto-resume.js";
import { deriveAccountUsageLimit, parseUsageLimitResetFromReason } from "./usage-limit.js";

const NOW_MS = Date.parse("2026-05-25T12:00:00.000Z");

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "sess-1",
    workspaceId: "ws-1",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "rate_limited",
    statusReason: "pane:rate_limited:server",
    lastStatusAt: "2026-05-25T11:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    tmuxSessionName: "tmux-sess-1",
    tmuxSessionId: "$1",
    runtimeSessionId: "uuid-1",
    rateLimitResumeAttempts: 0,
    nextResumeAt: null,
    lastResumeFromRateLimitAt: null,
    createdAt: "2026-05-25T10:00:00.000Z",
    updatedAt: "2026-05-25T11:00:00.000Z",
    ...over,
  } satisfies AgentSession;
}

interface FakeDeps extends AutoResumeDeps {
  updates: Array<{ sessionId: string; update: Parameters<AutoResumeDeps["updateRateLimitResume"]>[1] }>;
  sendCalls: Array<Parameters<AutoResumeDeps["sendAgentMessage"]>[0]>;
  warnings: Array<{ msg: string; meta?: unknown }>;
  setSendBehavior(behavior: "ok" | "fail" | "throw"): void;
}

function makeDeps(opts: {
  sessions: AgentSession[];
  sendBehavior?: "ok" | "fail" | "throw";
  rng?: () => number;
  isAccountRateLimited?: AutoResumeDeps["isAccountRateLimited"];
  now?: () => Date;
}): FakeDeps {
  const updates: FakeDeps["updates"] = [];
  const sendCalls: FakeDeps["sendCalls"] = [];
  const warnings: FakeDeps["warnings"] = [];
  let sendBehavior: "ok" | "fail" | "throw" = opts.sendBehavior ?? "ok";
  const deps: FakeDeps = {
    now: opts.now ?? (() => new Date(NOW_MS)),
    listSessions: () => opts.sessions,
    sendAgentMessage: async (input) => {
      sendCalls.push(input);
      if (sendBehavior === "throw") throw new Error("synthetic send failure");
      if (sendBehavior === "fail") {
        const r: SendMessageResult = { ok: false, sessionId: input.sessionId, error: "session_has_no_terminal" };
        return r;
      }
      const r: SendMessageResult = {
        ok: true,
        sessionId: input.sessionId,
        workspaceId: "ws-1",
        tmuxSessionName: "tmux-sess-1",
      };
      return r;
    },
    updateRateLimitResume: (sessionId, update) => {
      const target = opts.sessions.find((s) => s.id === sessionId);
      if (target) Object.assign(target, update);
      updates.push({ sessionId, update });
    },
    logger: { warn: (msg, meta) => warnings.push({ msg, meta }) },
    updates,
    sendCalls,
    warnings,
    setSendBehavior: (b) => {
      sendBehavior = b;
    },
  };
  if (opts.rng) deps.rng = opts.rng;
  if (opts.isAccountRateLimited) deps.isAccountRateLimited = opts.isAccountRateLimited;
  return deps;
}

describe("pickResumePrompt", () => {
  it("returns a value from RESUME_PROMPTS for typical rng outputs", () => {
    for (const seed of [0, 0.1, 0.5, 0.99]) {
      expect(RESUME_PROMPTS).toContain(pickResumePrompt(() => seed));
    }
  });

  it("clamps boundary rng outputs", () => {
    expect(pickResumePrompt(() => 0)).toBe(RESUME_PROMPTS[0]);
    expect(pickResumePrompt(() => 0.9999999)).toBe(RESUME_PROMPTS[RESUME_PROMPTS.length - 1]);
  });

  it("survives NaN/Infinity rng outputs (defensive)", () => {
    expect(RESUME_PROMPTS).toContain(pickResumePrompt(() => Number.NaN));
    expect(RESUME_PROMPTS).toContain(pickResumePrompt(() => Number.POSITIVE_INFINITY));
  });
});

describe("computeNextDelayMs", () => {
  it("attempts=0 returns 1 min + jitter window", () => {
    // floor: rng=0 → BASE only; ceil: rng→1 → BASE + JITTER_MS.
    expect(computeNextDelayMs(0, () => 0)).toBe(BASE_DELAY_MS);
    expect(computeNextDelayMs(0, () => 0.999999)).toBeCloseTo(BASE_DELAY_MS + JITTER_MS, -2);
  });

  it("doubles cleanly through attempts 1..7", () => {
    // No jitter (rng → 0) keeps the math exact.
    expect(computeNextDelayMs(1, () => 0)).toBe(BASE_DELAY_MS * 2);
    expect(computeNextDelayMs(2, () => 0)).toBe(BASE_DELAY_MS * 4);
    expect(computeNextDelayMs(3, () => 0)).toBe(BASE_DELAY_MS * 8);
    expect(computeNextDelayMs(4, () => 0)).toBe(BASE_DELAY_MS * 16);
    expect(computeNextDelayMs(5, () => 0)).toBe(BASE_DELAY_MS * 32);
    expect(computeNextDelayMs(6, () => 0)).toBe(BASE_DELAY_MS * 64);
    expect(computeNextDelayMs(7, () => 0)).toBe(BASE_DELAY_MS * 128);
    expect(computeNextDelayMs(7, () => 0)).toBe(MAX_DELAY_MS);
  });

  it("caps at MAX_DELAY_MS for attempts 8+ (no further doubling)", () => {
    for (const attempts of [8, 9, 20, 100, 1_000]) {
      expect(computeNextDelayMs(attempts, () => 0)).toBe(MAX_DELAY_MS);
      // With max jitter it stays within MAX_DELAY_MS + JITTER_MS — never higher.
      expect(computeNextDelayMs(attempts, () => 0.999999)).toBeLessThanOrEqual(MAX_DELAY_MS + JITTER_MS);
    }
  });

  it("survives NaN rng (defensive)", () => {
    expect(computeNextDelayMs(3, () => Number.NaN)).toBe(BASE_DELAY_MS * 8);
  });
});

describe("runAutoResumeTick", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("schedules first attempt at 1 min + jitter; does not send yet", async () => {
    const deps = makeDeps({ sessions: [session({ nextResumeAt: null })], rng: () => 0 });
    const result = await runAutoResumeTick(deps);
    expect(result).toEqual({ resumed: 0, scheduled: 1, cleared: 0, healed: 0, postponed: false });
    expect(deps.sendCalls).toEqual([]);
    expect(deps.updates[0]?.update.nextResumeAt).toBe(new Date(NOW_MS + BASE_DELAY_MS).toISOString());
  });

  it("schedules into [1min, 2min] when jitter saturates", async () => {
    const deps = makeDeps({ sessions: [session({ nextResumeAt: null })], rng: () => 0.999999 });
    await runAutoResumeTick(deps);
    const scheduled = Date.parse(deps.updates[0]?.update.nextResumeAt as string);
    expect(scheduled).toBeGreaterThanOrEqual(NOW_MS + BASE_DELAY_MS);
    expect(scheduled).toBeLessThanOrEqual(NOW_MS + BASE_DELAY_MS + JITTER_MS);
  });

  it("skips sessions whose nextResumeAt is in the future", async () => {
    const future = new Date(NOW_MS + 5 * 60_000).toISOString();
    const deps = makeDeps({ sessions: [session({ nextResumeAt: future, rateLimitResumeAttempts: 2 })] });
    const result = await runAutoResumeTick(deps);
    expect(result.resumed).toBe(0);
    expect(deps.sendCalls).toHaveLength(0);
    expect(deps.updates).toHaveLength(0);
  });

  it("sends with source=system and optimistic=false when due, bumps attempts, schedules next", async () => {
    const due = new Date(NOW_MS - 5_000).toISOString();
    const deps = makeDeps({
      sessions: [session({ nextResumeAt: due, rateLimitResumeAttempts: 0 })],
      rng: () => 0,
    });
    const result = await runAutoResumeTick(deps);
    expect(result.resumed).toBe(1);
    expect(deps.sendCalls).toHaveLength(1);
    expect(deps.sendCalls[0]?.source).toBe("system");
    expect(deps.sendCalls[0]?.optimistic).toBe(false);
    expect(RESUME_PROMPTS).toContain(deps.sendCalls[0]?.message);
    const update = deps.updates.at(-1)?.update;
    expect(update?.rateLimitResumeAttempts).toBe(1);
    expect(update?.lastResumeFromRateLimitAt).toBe(new Date(NOW_MS).toISOString());
    // attempts=1, rng=0 → 2min exactly
    expect(update?.nextResumeAt).toBe(new Date(NOW_MS + BASE_DELAY_MS * 2).toISOString());
  });

  it("backoff doubles 1 → 2 → 4 → 8 … and caps at 128 min over many ticks (TA11)", async () => {
    const sess = session({
      nextResumeAt: new Date(NOW_MS - 1).toISOString(),
      rateLimitResumeAttempts: 0,
    });
    const deps = makeDeps({ sessions: [sess], rng: () => 0 });
    const expectedBaseMinutes = [2, 4, 8, 16, 32, 64, 128, 128, 128, 128, 128];
    let currentMs = NOW_MS;
    for (const expected of expectedBaseMinutes) {
      deps.now = () => new Date(currentMs);
      const before = sess.rateLimitResumeAttempts ?? 0;
      await runAutoResumeTick(deps);
      const scheduledIso = sess.nextResumeAt as string;
      const scheduledMs = Date.parse(scheduledIso);
      expect(scheduledMs - currentMs).toBe(expected * 60_000); // exact, since rng=0
      expect(sess.rateLimitResumeAttempts).toBe(before + 1);
      // Advance just past the scheduled time so the next tick fires.
      currentMs = scheduledMs + 1;
    }
    // Confirm attempts kept incrementing (cap is on DELAY, not on the counter)
    expect(sess.rateLimitResumeAttempts).toBe(expectedBaseMinutes.length);
  });

  it("on send failure (ok:false), bumps attempts + reschedules but skips lastResumeFromRateLimitAt", async () => {
    const due = new Date(NOW_MS - 1_000).toISOString();
    const deps = makeDeps({
      sessions: [session({ nextResumeAt: due, rateLimitResumeAttempts: 1 })],
      sendBehavior: "fail",
      rng: () => 0,
    });
    const result = await runAutoResumeTick(deps);
    expect(result.resumed).toBe(0);
    const update = deps.updates.at(-1)?.update;
    expect(update?.rateLimitResumeAttempts).toBe(2);
    expect(update?.nextResumeAt).toBe(new Date(NOW_MS + BASE_DELAY_MS * 4).toISOString());
    expect(update).not.toHaveProperty("lastResumeFromRateLimitAt");
    expect(deps.warnings.some((w) => w.msg.includes("send failed"))).toBe(true);
  });

  it("on send throw, still bumps attempts + reschedules + logs (TA10)", async () => {
    const due = new Date(NOW_MS - 1_000).toISOString();
    const deps = makeDeps({
      sessions: [session({ nextResumeAt: due, rateLimitResumeAttempts: 1 })],
      sendBehavior: "throw",
      rng: () => 0,
    });
    const result = await runAutoResumeTick(deps);
    expect(result.resumed).toBe(0);
    expect(deps.sendCalls).toHaveLength(1); // exactly one attempt (no double-send)
    const update = deps.updates.at(-1)?.update;
    expect(update?.rateLimitResumeAttempts).toBe(2);
    expect(update?.nextResumeAt).toBe(new Date(NOW_MS + BASE_DELAY_MS * 4).toISOString());
    expect(update).not.toHaveProperty("lastResumeFromRateLimitAt");
    expect(deps.warnings.some((w) => w.msg.includes("send threw"))).toBe(true);
  });

  it("self-heals when nextResumeAt is unparseable (B1)", async () => {
    const deps = makeDeps({
      sessions: [session({ nextResumeAt: "not-an-iso-string", rateLimitResumeAttempts: 3 })],
    });
    const result = await runAutoResumeTick(deps);
    expect(result.healed).toBe(1);
    expect(result.resumed).toBe(0);
    expect(deps.sendCalls).toHaveLength(0);
    const update = deps.updates.at(-1)?.update;
    expect(update?.nextResumeAt).toBeNull();
    // attempts is preserved — only nextResumeAt is cleared.
    expect(update).not.toHaveProperty("rateLimitResumeAttempts");
    expect(deps.warnings.some((w) => w.msg.includes("unparseable nextResumeAt"))).toBe(true);
  });

  it("clears stale bookkeeping when status is no longer rate_limited", async () => {
    const deps = makeDeps({
      sessions: [
        session({
          status: "running",
          statusReason: "pane:active:running",
          rateLimitResumeAttempts: 3,
          nextResumeAt: new Date(NOW_MS + 60_000).toISOString(),
          lastResumeFromRateLimitAt: "2026-05-25T11:30:00.000Z",
        }),
      ],
    });
    const result = await runAutoResumeTick(deps);
    expect(result.cleared).toBe(1);
    expect(deps.sendCalls).toHaveLength(0);
    const update = deps.updates.at(-1)?.update;
    expect(update?.rateLimitResumeAttempts).toBe(0);
    expect(update?.nextResumeAt).toBeNull();
    expect(update).not.toHaveProperty("lastResumeFromRateLimitAt");
  });

  it("does not churn DB writes for non-rate-limited sessions with no stale state", async () => {
    const deps = makeDeps({
      sessions: [
        session({
          status: "stopped",
          rateLimitResumeAttempts: 0,
          nextResumeAt: null,
        }),
      ],
    });
    await runAutoResumeTick(deps);
    expect(deps.updates).toHaveLength(0);
  });

  it("postpones everything when account-wide rate limit is active", async () => {
    const due = new Date(NOW_MS - 5_000).toISOString();
    const deps = makeDeps({
      sessions: [session({ nextResumeAt: due }), session({ id: "sess-2", nextResumeAt: due })],
      isAccountRateLimited: () => ({ resetAt: "2026-05-25T13:00:00.000Z" }),
    });
    const result = await runAutoResumeTick(deps);
    expect(result.postponed).toBe(true);
    expect(result.resumed).toBe(0);
    expect(deps.sendCalls).toHaveLength(0);
    expect(deps.updates).toHaveLength(0);
  });

  it("on account-RL release, sessions stagger via independent jitter (no thundering herd)", async () => {
    const due = new Date(NOW_MS - 5_000).toISOString();
    // RNG yields a different jitter for each call so two sessions don't collide.
    const seq = [0.1, 0.2, 0.7, 0.8];
    let i = 0;
    const deps = makeDeps({
      sessions: [
        session({ id: "s1", nextResumeAt: due, rateLimitResumeAttempts: 0 }),
        session({ id: "s2", nextResumeAt: due, rateLimitResumeAttempts: 0 }),
      ],
      rng: () => seq[i++ % seq.length] as number,
    });
    await runAutoResumeTick(deps);
    const u1 = deps.updates.find((u) => u.sessionId === "s1")?.update.nextResumeAt;
    const u2 = deps.updates.find((u) => u.sessionId === "s2")?.update.nextResumeAt;
    expect(u1).toBeDefined();
    expect(u2).toBeDefined();
    expect(u1).not.toBe(u2); // distinct timestamps — staggered
  });

  it("integration: rate_limited → due → send (optimistic:false) → still rate_limited → backoff doubles (TA12)", async () => {
    const sess = session({
      nextResumeAt: new Date(NOW_MS - 1).toISOString(),
      rateLimitResumeAttempts: 0,
    });
    const deps = makeDeps({ sessions: [sess], rng: () => 0 });

    // Tick 1: due → send → attempts=1, next at +2min, lastResumeFromRateLimitAt set
    await runAutoResumeTick(deps);
    expect(sess.rateLimitResumeAttempts).toBe(1);
    expect(sess.lastResumeFromRateLimitAt).toBe(new Date(NOW_MS).toISOString());
    const after1 = Date.parse(sess.nextResumeAt as string);
    expect(after1 - NOW_MS).toBe(BASE_DELAY_MS * 2);

    // Pane still shows banner; status_monitor would leave status=rate_limited.
    // Because we passed optimistic:false, the cockpit never flipped to
    // "running" — this protects backoff from being reset.
    expect(sess.status).toBe("rate_limited");

    // Tick 2 at 1ms past scheduled → send → attempts=2, next at +4min
    const t2 = after1 + 1;
    deps.now = () => new Date(t2);
    await runAutoResumeTick(deps);
    expect(sess.rateLimitResumeAttempts).toBe(2);
    expect(Date.parse(sess.nextResumeAt as string) - t2).toBe(BASE_DELAY_MS * 4);
  });

  it("integration: pane clears (status flips to running externally) → next tick clears state", async () => {
    const sess = session({
      nextResumeAt: new Date(NOW_MS + 60_000).toISOString(),
      rateLimitResumeAttempts: 2,
      lastResumeFromRateLimitAt: "2026-05-25T11:55:00.000Z",
    });
    const deps = makeDeps({ sessions: [sess] });
    // Simulate status_monitor pane observation reverting the status:
    sess.status = "idle";
    await runAutoResumeTick(deps);
    expect(sess.rateLimitResumeAttempts).toBe(0);
    expect(sess.nextResumeAt).toBeNull();
    expect(sess.lastResumeFromRateLimitAt).toBe("2026-05-25T11:55:00.000Z"); // breadcrumb preserved
  });
});

describe("startAutoResumeLoop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function loopHarness(opts: { tickMs?: number; slowMs?: number } = {}) {
    const tickMs = opts.tickMs ?? 60_000;
    let tickCount = 0;
    let resolveSlow: (() => void) | null = null;
    const sessions = [session({ nextResumeAt: new Date(NOW_MS - 1).toISOString() })];
    const deps = makeDeps({ sessions });
    if (opts.slowMs !== undefined) {
      deps.sendAgentMessage = async (input) => {
        deps.sendCalls.push(input);
        await new Promise<void>((res) => {
          resolveSlow = res;
        });
        return { ok: true, sessionId: input.sessionId };
      };
    }
    // Wrap listSessions to count tick invocations.
    const originalList = deps.listSessions;
    deps.listSessions = () => {
      tickCount += 1;
      return originalList();
    };
    const handle = startAutoResumeLoop(deps, tickMs);
    return {
      deps,
      handle,
      tickMs,
      getTickCount: () => tickCount,
      resolveSlow: () => resolveSlow?.(),
    };
  }

  it("overlap guard: a slow tick prevents stacked invocations (TA5)", async () => {
    const h = loopHarness({ slowMs: 1 });
    // First interval fires → tick 1 starts; sendAgentMessage hangs.
    await vi.advanceTimersByTimeAsync(h.tickMs);
    expect(h.getTickCount()).toBe(1);
    expect(h.deps.sendCalls).toHaveLength(1);
    // Three more intervals fire while tick 1 is still hung — they must be skipped.
    await vi.advanceTimersByTimeAsync(h.tickMs * 3);
    expect(h.getTickCount()).toBe(1); // unchanged
    expect(h.deps.sendCalls).toHaveLength(1);
    // Resolve the slow send; the running flag clears in .finally.
    h.resolveSlow();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    // Next interval after resolution should proceed.
    await vi.advanceTimersByTimeAsync(h.tickMs);
    expect(h.getTickCount()).toBe(2);
    h.handle.stop();
  });

  it("stop() halts all subsequent ticks (TA-stop)", async () => {
    const h = loopHarness();
    await vi.advanceTimersByTimeAsync(h.tickMs);
    expect(h.getTickCount()).toBe(1);
    h.handle.stop();
    await vi.advanceTimersByTimeAsync(h.tickMs * 10);
    expect(h.getTickCount()).toBe(1); // never advances after stop
  });

  it("listSessions throwing does not deadlock the loop (running flag resets) (TA7)", async () => {
    let throwNext = true;
    const sessions = [session({ nextResumeAt: new Date(NOW_MS - 1).toISOString() })];
    const deps = makeDeps({ sessions });
    deps.listSessions = () => {
      if (throwNext) {
        throwNext = false;
        throw new Error("synthetic listSessions failure");
      }
      return sessions;
    };
    const handle = startAutoResumeLoop(deps, 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.warnings.some((w) => w.msg.includes("tick failed"))).toBe(true);
    // Subsequent tick proceeds.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.sendCalls).toHaveLength(1);
    handle.stop();
  });
});

describe("parseUsageLimitResetFromReason", () => {
  it("extracts the iso timestamp from `pane:usage_limited:reset=<iso>`", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=2026-05-26T07:50:00.000Z")).toBe(
      "2026-05-26T07:50:00.000Z",
    );
  });

  it("returns null for `reset=unknown` sentinel", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=unknown")).toBeNull();
  });

  it("returns null for unrelated reason strings", () => {
    expect(parseUsageLimitResetFromReason("pane:rate_limited:server")).toBeNull();
    expect(parseUsageLimitResetFromReason("pane:active:idle")).toBeNull();
    expect(parseUsageLimitResetFromReason(null)).toBeNull();
    expect(parseUsageLimitResetFromReason(undefined)).toBeNull();
  });

  it("returns null when the embedded value isn't a parseable date", () => {
    expect(parseUsageLimitResetFromReason("pane:usage_limited:reset=not-a-date")).toBeNull();
  });
});

describe("deriveAccountUsageLimit", () => {
  const now = new Date("2026-05-26T05:00:00.000Z");

  it("returns null when no session is usage_limited", () => {
    expect(deriveAccountUsageLimit([session({ status: "idle", statusReason: "pane:active:idle" })], now)).toBeNull();
  });

  it("returns the latest still-future resetAt across multiple usage_limited sessions", () => {
    const sessions = [
      session({
        id: "a",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T07:50:00.000Z",
      }),
      session({
        id: "b",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T09:15:00.000Z",
      }),
    ];
    expect(deriveAccountUsageLimit(sessions, now)).toEqual({ resetAt: "2026-05-26T09:15:00.000Z" });
  });

  it("ignores resets that have already passed (those sessions are due to wake)", () => {
    const sessions = [
      session({
        id: "a",
        status: "usage_limited",
        statusReason: "pane:usage_limited:reset=2026-05-26T04:00:00.000Z", // past
      }),
    ];
    expect(deriveAccountUsageLimit(sessions, now)).toBeNull();
  });

  it("returns a 1-min holdover when a usage_limited session has unknown reset", () => {
    const sessions = [session({ status: "usage_limited", statusReason: "pane:usage_limited:reset=unknown" })];
    const result = deriveAccountUsageLimit(sessions, now);
    if (result === null) throw new Error("expected non-null AccountRateLimitInfo");
    expect(Date.parse(result.resetAt) - now.getTime()).toBe(60_000);
  });
});

describe("runAutoResumeTick — usage_limited branch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT nudge while reset is in the future", async () => {
    const future = new Date(NOW_MS + 60 * 60_000).toISOString(); // +1h
    const sessions = [
      session({
        status: "usage_limited",
        statusReason: `pane:usage_limited:reset=${future}`,
      }),
    ];
    const deps = makeDeps({ sessions });
    const result = await runAutoResumeTick(deps);
    expect(deps.sendCalls).toHaveLength(0);
    expect(result.resumed).toBe(0);
  });

  it("nudges once after the reset wall-clock has passed", async () => {
    const past = new Date(NOW_MS - 1).toISOString();
    const sessions = [session({ status: "usage_limited", statusReason: `pane:usage_limited:reset=${past}` })];
    const deps = makeDeps({ sessions });
    const result = await runAutoResumeTick(deps);
    expect(deps.sendCalls).toHaveLength(1);
    expect(deps.sendCalls[0]?.source).toBe("system");
    expect(deps.sendCalls[0]?.optimistic).toBe(false);
    expect(result.resumed).toBe(1);
  });

  it("skips when statusReason is reset=unknown (no horizon to wait against)", async () => {
    const sessions = [session({ status: "usage_limited", statusReason: "pane:usage_limited:reset=unknown" })];
    const deps = makeDeps({ sessions });
    await runAutoResumeTick(deps);
    expect(deps.sendCalls).toHaveLength(0);
  });
});
