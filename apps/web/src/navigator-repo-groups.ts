import type { Repo, WorktreeCheckout } from "@citadel/contracts";
import { repoNameWithOwner } from "./repo-labels.js";

const UNKNOWN_REPO_LABEL = "Unknown repo";
const REPO_GROUP_PREFIX = "repo=";

export function repoGroupNameFromPath(path: string): string | null {
  const segment = path.split("/").find((part) => part.startsWith(REPO_GROUP_PREFIX));
  return segment ? segment.slice(REPO_GROUP_PREFIX.length) : null;
}

export function currentRepoGroupNameFromPath(path: string): string | null {
  const segments = path.split("/");
  const segment = segments[segments.length - 1];
  return segment?.startsWith(REPO_GROUP_PREFIX) ? segment.slice(REPO_GROUP_PREFIX.length) : null;
}

export function repoByGroupName(name: string | null, repos: readonly Repo[]): Repo | null {
  if (!name || name === UNKNOWN_REPO_LABEL) return null;
  return repos.find((repo) => repoNameWithOwner(repo) === name) ?? null;
}

export function checkoutMatchesRepoGroup(
  checkout: WorktreeCheckout,
  repoGroupName: string,
  repos: readonly Repo[],
): boolean {
  const repo = repos.find((entry) => entry.id === checkout.repoId) ?? null;
  return repoGroupName === UNKNOWN_REPO_LABEL
    ? repo === null
    : repo
      ? repoNameWithOwner(repo) === repoGroupName
      : false;
}
