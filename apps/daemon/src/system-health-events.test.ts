import type { SystemHealthSnapshot } from "@citadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SYSTEM_HEALTH_UPDATED_EVENT, startSystemHealthEvents } from "./system-health-events.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("startSystemHealthEvents", () => {
  it("emits compact health snapshots on the configured interval only while viewers are attached", () => {
    vi.useFakeTimers();
    let hasViewers = false;
    const emit = vi.fn();
    const collect = vi.fn(() => snapshot);
    const ticker = startSystemHealthEvents({
      config: { dataDir: "/tmp/citadel" } as Parameters<typeof startSystemHealthEvents>[0]["config"],
      emit,
      hasViewers: () => hasViewers,
      intervalMs: 100,
      collect,
    });

    vi.advanceTimersByTime(100);
    expect(emit).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();

    hasViewers = true;
    vi.advanceTimersByTime(100);
    expect(collect).toHaveBeenCalledWith({ diskPath: "/tmp/citadel" });
    expect(emit).toHaveBeenCalledWith(SYSTEM_HEALTH_UPDATED_EVENT, snapshot);

    ticker.stop();
    vi.advanceTimersByTime(100);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

const snapshot: SystemHealthSnapshot = {
  tone: "healthy",
  reason: null,
  checkedAt: "2026-06-05T00:00:00.000Z",
  machine: {
    cpu: { percentUsed: 12, loadAverage1m: 0.5, cores: 8 },
    memory: { totalBytes: 100, usedBytes: 50, freeBytes: 50, percentUsed: 50 },
    disk: {
      path: "/tmp/citadel",
      device: "sda1",
      totalBytes: 100,
      usedBytes: 35,
      freeBytes: 65,
      percentUsed: 35,
      ioUtilizationPercent: 10,
      error: null,
    },
  },
  process: { pid: 123, rssBytes: 40, heapUsedBytes: 20, heapTotalBytes: 30, percentOfMachineMemory: 1 },
};
