import { describe, expect, it } from "vitest";
import { cpuPercentUsed, deriveSystemHealthTone } from "./system-health.js";

describe("system health telemetry", () => {
  it("derives CPU usage from consecutive CPU time samples", () => {
    expect(cpuPercentUsed({ idle: 150, total: 300 }, { idle: 100, total: 200 }, 0, 4)).toBe(50);
  });

  it("falls back to load average when no prior CPU sample exists", () => {
    expect(cpuPercentUsed({ idle: 0, total: 0 }, null, 2, 4)).toBe(50);
  });

  it("escalates the general tone for low disk space", () => {
    expect(
      deriveSystemHealthTone({
        cpuPercentUsed: 20,
        memoryPercentUsed: 30,
        diskPercentUsed: 40,
        diskIoUtilizationPercent: 5,
        diskFreeBytes: 1024 ** 3,
        diskError: null,
        processMemoryPercentOfMachine: 2,
      }),
    ).toEqual({ tone: "critical", reason: "disk space below 2 GB" });
  });

  it("escalates the general tone for saturated disk I/O", () => {
    expect(
      deriveSystemHealthTone({
        cpuPercentUsed: 20,
        memoryPercentUsed: 30,
        diskPercentUsed: 40,
        diskIoUtilizationPercent: 87,
        diskFreeBytes: 100 * 1024 ** 3,
        diskError: null,
        processMemoryPercentOfMachine: 2,
      }),
    ).toEqual({ tone: "degraded", reason: "disk I/O 87%" });
  });
});
