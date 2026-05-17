import { describe, expect, it } from "vitest";
import { cliPlaceholder } from "./index.js";

describe("cliPlaceholder", () => {
  it("keeps the thin helper CLI package importable", () => {
    expect(cliPlaceholder()).toContain("Citadel CLI");
  });
});
