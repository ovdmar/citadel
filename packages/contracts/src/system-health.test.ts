import { describe, expect, it } from "vitest";
import { SystemHealthSnapshotSchema, SystemResourceOffenderBreakdownSchema } from "./system-health.js";

describe("system health contracts", () => {
  it("validates the cockpit footer health snapshot", () => {
    const snapshot = SystemHealthSnapshotSchema.parse({
      tone: "healthy",
      reason: null,
      checkedAt: "2026-06-05T12:00:00.000Z",
      machine: {
        cpu: { percentUsed: 12.5, loadAverage1m: 0.5, cores: 8 },
        memory: { totalBytes: 16, usedBytes: 8, freeBytes: 8, percentUsed: 50 },
        disk: {
          path: "/tmp",
          device: "sda1",
          totalBytes: 100,
          usedBytes: 40,
          freeBytes: 60,
          percentUsed: 40,
          ioUtilizationPercent: 2,
          error: null,
        },
      },
      process: {
        pid: 123,
        rssBytes: 1024,
        heapUsedBytes: 512,
        heapTotalBytes: 768,
        percentOfMachineMemory: 1.2,
      },
    });

    expect(snapshot.tone).toBe("healthy");
    expect(snapshot.machine.disk.freeBytes).toBe(60);
  });

  it("validates resource offender breakdowns for hover details", () => {
    const breakdown = SystemResourceOffenderBreakdownSchema.parse({
      resource: "cpu",
      checkedAt: "2026-06-05T12:00:00.000Z",
      status: "available",
      reason: null,
      offenders: [
        {
          id: "pid:123",
          label: "node",
          detail: "node dist/main.js",
          pid: 123,
          value: 48.2,
          unit: "percent",
        },
      ],
    });

    expect(breakdown.offenders).toHaveLength(1);
    expect(breakdown.offenders[0]?.unit).toBe("percent");
  });
});
