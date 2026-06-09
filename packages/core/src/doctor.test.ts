import type { DoctorCheck } from "@citadel/contracts/doctor";
import { describe, expect, it } from "vitest";
import { groupChecksByKind, statusLabel, summarizeDoctor } from "./doctor.js";

function check(overrides: Partial<DoctorCheck>): DoctorCheck {
  return {
    id: "test",
    kind: "binary",
    label: "test",
    status: "ok",
    ...overrides,
  };
}

describe("summarizeDoctor", () => {
  it("returns 'ok' when every check is ok or skipped", () => {
    expect(
      summarizeDoctor([
        check({ id: "a", status: "ok" }),
        check({ id: "b", status: "skipped" }),
        check({ id: "c", status: "ok" }),
      ]),
    ).toBe("ok");
  });

  it("returns 'ok' for an empty list", () => {
    expect(summarizeDoctor([])).toBe("ok");
  });

  it("returns 'degraded' when at least one check is warn but none fail", () => {
    expect(
      summarizeDoctor([
        check({ id: "a", status: "ok" }),
        check({ id: "b", status: "warn" }),
        check({ id: "c", status: "skipped" }),
      ]),
    ).toBe("degraded");
  });

  it("returns 'failing' the moment any check is fail (overrides warn)", () => {
    expect(
      summarizeDoctor([
        check({ id: "a", status: "warn" }),
        check({ id: "b", status: "fail" }),
        check({ id: "c", status: "ok" }),
      ]),
    ).toBe("failing");
  });

  it("'skipped' alone does not promote the summary above 'ok'", () => {
    expect(summarizeDoctor([check({ status: "skipped" })])).toBe("ok");
  });

  it("precedence: fail > warn > ok regardless of order", () => {
    // Same checks shuffled — verdict is order-independent.
    const a = check({ id: "a", status: "fail" });
    const b = check({ id: "b", status: "warn" });
    const c = check({ id: "c", status: "ok" });
    expect(summarizeDoctor([a, b, c])).toBe("failing");
    expect(summarizeDoctor([c, b, a])).toBe("failing");
    expect(summarizeDoctor([b, a, c])).toBe("failing");
  });
});

describe("groupChecksByKind", () => {
  it("groups checks by kind, preserving order within each group", () => {
    const checks: DoctorCheck[] = [
      check({ id: "node", kind: "binary" }),
      check({ id: "config", kind: "config" }),
      check({ id: "pnpm", kind: "binary" }),
      check({ id: "daemon", kind: "daemon" }),
    ];
    const grouped = groupChecksByKind(checks);
    expect(grouped.binary?.map((c) => c.id)).toEqual(["node", "pnpm"]);
    expect(grouped.config?.map((c) => c.id)).toEqual(["config"]);
    expect(grouped.daemon?.map((c) => c.id)).toEqual(["daemon"]);
  });
});

describe("statusLabel", () => {
  it("returns a stable human label per status", () => {
    expect(statusLabel("ok")).toBe("OK");
    expect(statusLabel("warn")).toBe("Warning");
    expect(statusLabel("fail")).toBe("Fail");
    expect(statusLabel("skipped")).toBe("Skipped");
  });
});
