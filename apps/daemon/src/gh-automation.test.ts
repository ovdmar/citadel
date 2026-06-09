import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CiProviderSummary, Workspace } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { automatedGhEnabled, cachedCiOrDisabled, cachedCiOrSkipped, shouldFetchGithubCi } from "./gh-automation.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeGitRepo(): { repoPath: string; headSha: string } {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-gh-auto-"));
  dirs.push(repoPath);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
  return { repoPath, headSha };
}

function makeWorkspace(pathname: string): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Workspace",
    path: pathname,
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    archivedAt: null,
  };
}

describe("automatedGhEnabled", () => {
  it("defaults on for the main install and off for worktree deploys", () => {
    expect(automatedGhEnabled({})).toBe(true);
    expect(automatedGhEnabled({ CITADEL_WORKTREE: "1" })).toBe(false);
    expect(automatedGhEnabled({ CITADEL_WORKTREE: "1", CITADEL_ENABLE_WORKTREE_GH_AUTOMATION: "1" })).toBe(true);
  });

  it("honors the explicit CITADEL_AUTOMATED_GH override", () => {
    expect(automatedGhEnabled({ CITADEL_AUTOMATED_GH: "0" })).toBe(false);
    expect(automatedGhEnabled({ CITADEL_WORKTREE: "1", CITADEL_AUTOMATED_GH: "1" })).toBe(true);
  });
});

describe("shouldFetchGithubCi", () => {
  it("waits for PR metadata before polling CI", () => {
    const git = makeGitRepo();
    const workspace = makeWorkspace(git.repoPath);
    const store = {
      getWorkspacePrSnapshot: () => null,
    };

    expect(shouldFetchGithubCi(store, workspace)).toBe(false);
  });

  it("does not poll CI when the current head is known to have no PR", () => {
    const git = makeGitRepo();
    const workspace = makeWorkspace(git.repoPath);
    const store = {
      getWorkspacePrSnapshot: () => ({
        prNumber: null,
        prState: null,
        lastFetchAt: "2026-05-27T00:00:00.000Z",
        lastHeadSha: git.headSha,
        lastHeadShaChangedAt: "2026-05-27T00:00:00.000Z",
        lastChecksGreenAt: null,
        lastMergeStateStatus: null,
      }),
    };

    expect(shouldFetchGithubCi(store, workspace)).toBe(false);
  });

  it("stops CI polling for green PRs until local HEAD changes", () => {
    const git = makeGitRepo();
    const workspace = makeWorkspace(git.repoPath);
    const store = {
      getWorkspacePrSnapshot: () => ({
        prNumber: 42,
        prState: "open" as const,
        lastFetchAt: "2026-05-27T00:00:00.000Z",
        lastHeadSha: git.headSha,
        lastHeadShaChangedAt: "2026-05-27T00:00:00.000Z",
        lastChecksGreenAt: "2026-05-27T00:00:00.000Z",
        lastMergeStateStatus: null,
      }),
    };

    expect(shouldFetchGithubCi(store, workspace)).toBe(false);
  });

  it("allows CI polling after a new local PR commit", () => {
    const git = makeGitRepo();
    const workspace = makeWorkspace(git.repoPath);
    const store = {
      getWorkspacePrSnapshot: () => ({
        prNumber: 42,
        prState: "open" as const,
        lastFetchAt: "2026-05-27T00:00:00.000Z",
        lastHeadSha: "old",
        lastHeadShaChangedAt: "2026-05-27T00:00:00.000Z",
        lastChecksGreenAt: "2026-05-27T00:00:00.000Z",
        lastMergeStateStatus: null,
      }),
    };

    expect(shouldFetchGithubCi(store, workspace)).toBe(true);
  });
});

describe("cachedCiOrDisabled", () => {
  it("serves stale CI cache entries when automation declines to poll", () => {
    const ci: CiProviderSummary = {
      providerId: "github-gh",
      status: "healthy",
      reason: null,
      runs: [],
      checkedAt: "2026-05-27T00:00:00.000Z",
    };
    const cache = new Map<string, { expiresAt: number; value: unknown }>([
      ["ci:owner/repo:abc123", { expiresAt: Date.now() - 1, value: ci }],
    ]);

    expect(cachedCiOrDisabled(cache, "ci:owner/repo:abc123", "disabled")).toBe(ci);
  });
});

describe("cachedCiOrSkipped", () => {
  it("returns a non-degrading empty summary when CI is intentionally skipped", () => {
    const ci = cachedCiOrSkipped(new Map(), "ci:owner/repo:abc123", "GitHub CI is cached");
    expect(ci.status).toBe("healthy");
    expect(ci.reason).toContain("cached");
    expect(ci.runs).toEqual([]);
  });
});
