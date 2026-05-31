import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultWorktreeParent } from "./index.js";

describe("defaultWorktreeParent", () => {
  it("uses Citadel dataDir storage when dataDir is available", () => {
    expect(defaultWorktreeParent("/home/me/Workspace/meshes-studio", "/home/me/.local/share/citadel")).toBe(
      path.join("/home/me/.local/share/citadel", "worktrees", "meshes-studio"),
    );
  });

  it("keeps the legacy sibling fallback without dataDir", () => {
    expect(defaultWorktreeParent("/home/me/Workspace/meshes-studio")).toBe(
      path.join("/home/me/Workspace", "meshes-studio-worktrees"),
    );
  });
});
