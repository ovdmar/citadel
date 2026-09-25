import type { HookConfig } from "@citadel/config";
import type { Repo } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { listHookDiagnostics } from "./helpers.js";

const baseRepo: Repo = {
  id: "repo_1",
  name: "Repo",
  rootPath: "/tmp/repo",
  defaultBranch: "main",
  defaultRemote: "origin",
  worktreeParent: "/tmp/wt",
  setupHookIds: [],
  teardownHookIds: [],
  requestReviewHookIds: ["rev"],
  providerIds: [],
  deployHookCommand: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
};

const reviewHook: HookConfig = {
  id: "rev",
  kind: "command",
  event: "workspace.requestReview",
  command: "true",
  args: [],
  blocking: true,
};

describe("listHookDiagnostics", () => {
  it("surfaces workspace.requestReview hooks in the diagnostics list", () => {
    const diagnostics = listHookDiagnostics({
      repo: baseRepo,
      hooks: [reviewHook],
      appHookIds: [],
      actionHookIds: [],
      requestReviewHookIds: baseRepo.requestReviewHookIds,
      hookTimeoutMs: 5_000,
    });
    expect(diagnostics.map((d) => d.event)).toContain("workspace.requestReview");
    expect(diagnostics.find((d) => d.event === "workspace.requestReview")?.hookId).toBe("rev");
  });

  it("filters by requestReviewHookIds when the array is non-empty", () => {
    const otherHook: HookConfig = { ...reviewHook, id: "other" };
    const diagnostics = listHookDiagnostics({
      repo: baseRepo,
      hooks: [reviewHook, otherHook],
      appHookIds: [],
      actionHookIds: [],
      requestReviewHookIds: ["rev"],
      hookTimeoutMs: 5_000,
    });
    const reviewDiagnostics = diagnostics.filter((d) => d.event === "workspace.requestReview");
    expect(reviewDiagnostics.map((d) => d.hookId)).toEqual(["rev"]);
  });
});
