import { execFileSync } from "node:child_process";
import type { CiProviderSummary, Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore, WorkspacePrSnapshot } from "@citadel/db";
import type { ProviderCache } from "./app-helpers.js";

export const WORKTREE_GH_AUTOMATION_ENV = "CITADEL_ENABLE_WORKTREE_GH_AUTOMATION";
export const AUTOMATED_GH_DISABLED_REASON =
  "Automated GitHub polling is disabled for this worktree deploy. Set CITADEL_ENABLE_WORKTREE_GH_AUTOMATION=1 before make deploy to enable it.";

export function automatedGhEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CITADEL_AUTOMATED_GH === "1") return true;
  if (env.CITADEL_AUTOMATED_GH === "0") return false;
  if (env.CITADEL_WORKTREE === "1") return env[WORKTREE_GH_AUTOMATION_ENV] === "1";
  return true;
}

export function disabledVersionControlSummary(workspace: Workspace, repo: Repo): VersionControlSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason: AUTOMATED_GH_DISABLED_REASON,
    defaultBranch: repo.defaultBranch || null,
    currentBranch: workspace.branch || null,
    remotes: [repo.defaultRemote || "origin"],
    pullRequest: null,
    checkedAt: new Date().toISOString(),
  };
}

export function disabledCiSummary(reason = AUTOMATED_GH_DISABLED_REASON): CiProviderSummary {
  return {
    providerId: "github-gh",
    status: "unavailable",
    reason,
    runs: [],
    checkedAt: new Date().toISOString(),
  };
}

export function skippedCiSummary(reason: string): CiProviderSummary {
  return {
    providerId: "github-gh",
    status: "healthy",
    reason,
    runs: [],
    checkedAt: new Date().toISOString(),
  };
}

export function cachedCiOrDisabled(cache: ProviderCache, key: string, reason: string): CiProviderSummary {
  const cached = cache.get(key);
  if (cached) return cached.value as CiProviderSummary;
  return disabledCiSummary(reason);
}

export function cachedCiOrSkipped(cache: ProviderCache, key: string, reason: string): CiProviderSummary {
  const cached = cache.get(key);
  if (cached) return cached.value as CiProviderSummary;
  return skippedCiSummary(reason);
}

export function githubCiCacheKey(
  workspace: Workspace,
  repo: Repo,
  repoFullName: string | null,
  snapshot: WorkspacePrSnapshot | null,
): string {
  const repoScope = (repoFullName ?? repo.id).replace(/[^a-zA-Z0-9_.#/-]/g, "_");
  const headScope = snapshot?.lastHeadSha ?? workspace.branch;
  return `ci:${repoScope}:${headScope}`;
}

export function shouldFetchGithubCi(store: Pick<SqliteStore, "getWorkspacePrSnapshot">, workspace: Workspace): boolean {
  return githubCiFetchDecision(store, workspace).fetch;
}

export function githubCiSkipReason(
  store: Pick<SqliteStore, "getWorkspacePrSnapshot">,
  workspace: Workspace,
): string | null {
  const decision = githubCiFetchDecision(store, workspace);
  return decision.fetch ? null : decision.reason;
}

function githubCiFetchDecision(
  store: Pick<SqliteStore, "getWorkspacePrSnapshot">,
  workspace: Workspace,
): { fetch: true } | { fetch: false; reason: string } {
  const snapshot = store.getWorkspacePrSnapshot(workspace.id);
  if (!snapshot) return { fetch: false, reason: "GitHub CI is cached until PR metadata is fetched" };
  if (!snapshot.prNumber) return { fetch: false, reason: "GitHub CI is skipped because this workspace has no PR" };
  const localHead = readLocalHead(workspace.path);
  if (!localHead || !snapshot.lastHeadSha || localHead !== snapshot.lastHeadSha) return { fetch: true };
  if (snapshot.prState === "merged" || snapshot.prState === "closed") {
    return { fetch: false, reason: "GitHub CI is cached because the PR is no longer open" };
  }
  if (snapshot.lastMergeStateStatus === "DIRTY") {
    return { fetch: false, reason: "GitHub CI is cached while the PR has conflicts" };
  }
  if (snapshot.lastChecksGreenAt) {
    return { fetch: false, reason: "GitHub CI is cached until the PR receives a new local commit" };
  }
  return { fetch: true };
}

function readLocalHead(workspacePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
