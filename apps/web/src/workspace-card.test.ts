import { describe, expect, it } from "vitest";
import { lifecycleToneClass } from "./workspace-card.js";

// `deriveWorkspaceLifecycleTone` and `deriveAgentLifecycleTone` are exercised
// in packages/core/src/index.test.ts against the full status × exit-code ×
// PR matrix. Here we only pin the CSS-class mapping, which is the
// workspace-card layer's responsibility.
describe("lifecycleToneClass", () => {
  it("maps never-started to cit-pulse-idle (the only grey-static case)", () => {
    expect(lifecycleToneClass("never-started")).toBe("cit-pulse-idle");
  });

  it("maps running to cit-pulse-run (orange ripple)", () => {
    expect(lifecycleToneClass("running")).toBe("cit-pulse-run");
  });

  it("maps done to cit-pulse-done — distinct from solid-green cit-pulse-ok", () => {
    // cit-pulse-ok is reserved for non-lifecycle indicators (auto-mode pill,
    // deploy-health badge). Using cit-pulse-done here keeps the lifecycle
    // ripple from spilling onto those untouched call sites.
    expect(lifecycleToneClass("done")).toBe("cit-pulse-done");
    expect(lifecycleToneClass("done")).not.toBe("cit-pulse-ok");
  });

  it("maps rate-limited to cit-pulse-info (blue ripple)", () => {
    expect(lifecycleToneClass("rate-limited")).toBe("cit-pulse-info");
  });

  it("maps attention to cit-pulse-bad (red ripple)", () => {
    expect(lifecycleToneClass("attention")).toBe("cit-pulse-bad");
  });
});
