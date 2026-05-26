import type { Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { filterPollableWorkspaceIds, nextPollInterval, prMapFromBatch } from "./cockpit-tools.js";

const workspace = (overrides: Partial<Workspace>): Workspace =>
  ({
    id: "ws_test",
    repoId: "repo_test",
    name: "Test",
    path: "/tmp/repo",
    branch: "feature",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: "2026-05-01T00:00:00Z",
    updatedAt: "2026-05-01T00:00:00Z",
    archivedAt: null,
    ...overrides,
  }) as Workspace;

describe("filterPollableWorkspaceIds", () => {
  it("drops root-kind workspaces so the daemon doesn't waste gh spawns on them", () => {
    expect(
      filterPollableWorkspaceIds([
        workspace({ id: "ws_a", kind: "worktree" }),
        workspace({ id: "ws_root", kind: "root" }),
        workspace({ id: "ws_b", kind: "worktree" }),
      ]),
    ).toEqual(["ws_a", "ws_b"]);
  });

  it("returns an empty list when every workspace is root — react-query then disables the poll", () => {
    expect(
      filterPollableWorkspaceIds([workspace({ id: "ws_r1", kind: "root" }), workspace({ id: "ws_r2", kind: "root" })]),
    ).toEqual([]);
  });
});

describe("nextPollInterval", () => {
  it("polls every 30s when the tab is visible", () => {
    expect(nextPollInterval("visible")).toBe(30_000);
  });

  it("returns false (pause) when the tab is hidden so daemon spawn pressure goes to zero", () => {
    expect(nextPollInterval("hidden")).toBe(false);
  });

  it("falls back to polling when visibilityState is undefined (non-browser host)", () => {
    expect(nextPollInterval(undefined)).toBe(30_000);
  });
});

describe("prMapFromBatch", () => {
  it("collapses per-workspace failures (no-remote, root-workspace, workspace_not_found) to null", () => {
    const map = prMapFromBatch({
      summaries: [
        { workspaceId: "ws_no_remote", ok: false, reason: "no-remote" },
        { workspaceId: "ws_root", ok: false, reason: "root-workspace" },
        { workspaceId: "ws_missing", ok: false, reason: "workspace_not_found" },
      ],
    });
    expect(map.get("ws_no_remote")).toBeNull();
    expect(map.get("ws_root")).toBeNull();
    expect(map.get("ws_missing")).toBeNull();
  });

  it("returns the pullRequest from the cockpit summary on the ok envelope", () => {
    const pr = {
      number: 42,
      title: "Test",
      url: "https://x.test/pr/42",
      state: "OPEN",
      draft: false,
      reviewDecision: null,
      checks: [],
      additions: 0,
      deletions: 0,
      reviewers: [],
      commits: [],
      parentPr: null,
      mergeable: "unknown",
      allowedMergeStrategies: [],
    };
    const map = prMapFromBatch({
      summaries: [
        {
          workspaceId: "ws_ok",
          ok: true,
          summary: {
            versionControl: { pullRequest: pr },
          },
        },
      ],
    });
    expect(map.get("ws_ok")).toEqual(pr);
  });

  it("returns null when the cockpit summary's pullRequest field is null (no PR for the workspace)", () => {
    const map = prMapFromBatch({
      summaries: [
        {
          workspaceId: "ws_nopr",
          ok: true,
          summary: { versionControl: { pullRequest: null } },
        },
      ],
    });
    expect(map.get("ws_nopr")).toBeNull();
  });
});
