import { describe, expect, it } from "vitest";
import { safeTestRepoName } from "./index.js";

describe("safeTestRepoName", () => {
  it("returns names scoped to disposable Citadel fixtures", () => {
    expect(safeTestRepoName()).toMatch(/^citadel-test-[a-z0-9]+$/);
  });
});
