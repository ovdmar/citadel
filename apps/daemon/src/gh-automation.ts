import { execFileSync } from "node:child_process";
import type { CiProviderSummary, Repo, VersionControlSummary, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
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

export function cachedCiOrDisabled(cache: ProviderCache, key: string, reason: string): CiProviderSummary {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as CiProviderSummary;
  return disabledCiSummary(reason);
}

export function shouldFetchGithubCi(store: Pick<SqliteStore, "getWorkspacePrSnapshot">, workspace: Workspace): boolean {
  const snapshot = store.getWorkspacePrSnapshot(workspace.id);
  if (!snapshot?.prNumber) return true;
  const localHead = readLocalHead(workspace.path);
  if (!localHead || !snapshot.lastHeadSha || localHead !== snapshot.lastHeadSha) return true;
  if (snapshot.prState === "merged" || snapshot.prState === "closed") return false;
  if (snapshot.lastMergeStateStatus === "DIRTY") return false;
  if (snapshot.lastChecksGreenAt) return false;
  return true;
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
