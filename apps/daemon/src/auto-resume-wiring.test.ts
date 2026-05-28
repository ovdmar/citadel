import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDaemonAutoResumeLoop } from "./auto-resume-wiring.js";

// Mock the operations module so we can observe the interval setInterval was
// called with (rather than actually start a real loop).
let lastIntervalMs: number | null = null;
let stopCalls = 0;
let lastDepsCaptured: unknown = null;

vi.mock("@citadel/operations", async () => {
  const actual = await vi.importActual<typeof import("@citadel/operations")>("@citadel/operations");
  return {
    ...actual,
    startAutoResumeLoop: (deps: unknown, intervalMs: number) => {
      lastIntervalMs = intervalMs;
      lastDepsCaptured = deps;
      return {
        stop: () => {
          stopCalls += 1;
        },
      };
    },
  };
});

const fakeStore = { listSessions: () => [], updateSessionRateLimitResume: () => {} } as unknown as SqliteStore;
const fakeOps = { sendAgentMessage: async () => ({ ok: true }) } as unknown as OperationService;

const originalEnv = { ...process.env };

describe("startDaemonAutoResumeLoop env parsing", () => {
  beforeEach(() => {
    lastIntervalMs = null;
    lastDepsCaptured = null;
    stopCalls = 0;
    // Wipe both knobs to a known baseline; reinstate after each test. We
    // genuinely need delete here — assigning undefined stores the literal
    // string "undefined" rather than removing the key, which would defeat
    // the "missing env" assertions below.
    // biome-ignore lint/performance/noDelete: legitimate test env cleanup
    delete process.env.CITADEL_DISABLE_AUTO_RESUME;
    // biome-ignore lint/performance/noDelete: legitimate test env cleanup
    delete process.env.CITADEL_AUTO_RESUME_INTERVAL_MS;
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when CITADEL_DISABLE_AUTO_RESUME=1", () => {
    process.env.CITADEL_DISABLE_AUTO_RESUME = "1";
    expect(startDaemonAutoResumeLoop(fakeStore, fakeOps)).toBeNull();
    expect(lastIntervalMs).toBeNull(); // loop never started
  });

  it("does NOT disable for truthy-strings other than '1'", () => {
    for (const v of ["true", "yes", "0", "false", ""]) {
      process.env.CITADEL_DISABLE_AUTO_RESUME = v;
      const handle = startDaemonAutoResumeLoop(fakeStore, fakeOps);
      expect(handle).not.toBeNull();
      handle?.stop();
    }
  });

  it("uses 60_000 default when CITADEL_AUTO_RESUME_INTERVAL_MS is missing/empty/invalid", () => {
    for (const v of [undefined, "", "abc", "NaN", "0", "-1", "-1000"]) {
      lastIntervalMs = null;
      if (v === undefined) {
        // biome-ignore lint/performance/noDelete: legitimate test env cleanup
        delete process.env.CITADEL_AUTO_RESUME_INTERVAL_MS;
      } else process.env.CITADEL_AUTO_RESUME_INTERVAL_MS = v;
      const handle = startDaemonAutoResumeLoop(fakeStore, fakeOps);
      expect(handle).not.toBeNull();
      expect(lastIntervalMs).toBe(60_000);
      handle?.stop();
    }
  });

  it("uses the env value when CITADEL_AUTO_RESUME_INTERVAL_MS is a positive number", () => {
    process.env.CITADEL_AUTO_RESUME_INTERVAL_MS = "30000";
    const handle = startDaemonAutoResumeLoop(fakeStore, fakeOps);
    expect(lastIntervalMs).toBe(30_000);
    handle?.stop();
    expect(stopCalls).toBe(1);
  });

  it("wires deps with source/optimistic forwarded to operations.sendAgentMessage", async () => {
    let captured: unknown = null;
    const ops = {
      sendAgentMessage: async (input: unknown) => {
        captured = input;
        return { ok: true };
      },
    } as unknown as OperationService;
    startDaemonAutoResumeLoop(fakeStore, ops);
    const deps = lastDepsCaptured as {
      sendAgentMessage: (input: {
        sessionId: string;
        message: string;
        source?: string;
        optimistic?: boolean;
      }) => Promise<unknown>;
    };
    await deps.sendAgentMessage({
      sessionId: "s",
      message: "m",
      source: "system",
      optimistic: false,
    });
    expect(captured).toEqual({ sessionId: "s", message: "m", source: "system", optimistic: false });
  });
});
