import { describe, expect, it } from "vitest";
import { citadelUiPackage } from "./index.js";

describe("citadelUiPackage", () => {
  it("exports a stable package marker", () => {
    expect(citadelUiPackage).toContain("design-system");
  });
});
