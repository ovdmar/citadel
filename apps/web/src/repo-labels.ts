import type { Repo } from "@citadel/contracts";

export function repoNameWithOwner(repo: Repo | null): string {
  if (!repo) return "Unknown repo";
  return repo.providerRepositoryKey || repo.name;
}
