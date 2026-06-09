import { describe, expect, it } from "vitest";
import { DoctorCheckKindSchema } from "./doctor.js";

describe("doctor contracts", () => {
  it("includes agent runtime and terminal check kinds", () => {
    expect(DoctorCheckKindSchema.parse("agent-runtime")).toBe("agent-runtime");
    expect(DoctorCheckKindSchema.parse("terminal")).toBe("terminal");
  });
});
