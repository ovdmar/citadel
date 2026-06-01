import type { WorkspaceCockpitSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type {
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectJiraIssueSummary,
} from "@citadel/providers";
import {
  AUTOMATED_GH_DISABLED_REASON,
  cachedCiOrDisabled,
  disabledVersionControlSummary,
  githubCiCacheKey,
  shouldFetchGithubCi,
} from "./gh-automation.js";
import { decorateWithCooldown } from "./gh-quota-wiring.js";
import { deriveReadiness } from "./readiness.js";
import { fetchVersionControlGated } from "./vc-fetch-gated.js";
import { readWorkspaceGitStatus } from "./workspace-diff.js";

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
};

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;
type GatedVcDeps = Parameters<typeof fetchVersionControlGated>[0];

export function createWorkspaceCockpitSummaryBuilder(input: {
  store: SqliteStore;
  operations: OperationService;
  providers: ProviderCollectors;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  scheduler: GatedVcDeps["scheduler"];
  cachedProvider: CachedProvider;
  cachedProviderHealth: () => Promise<Array<{ status: string; reason: string | null }>>;
  ghAutomationEnabled: boolean;
  resolveRepoFullName: (repoId: string) => string | null;
}): (workspaceId: string) => Promise<WorkspaceCockpitSummary | null> {
  const {
    store,
    operations,
    providers,
    providerCache,
    scheduler,
    cachedProvider,
    cachedProviderHealth,
    ghAutomationEnabled,
    resolveRepoFullName,
  } = input;
  const collectVc: GatedVcDeps["collectVc"] = (path, deps) => providers.collectGitHubVersionControlSummary(path, deps);
  const gatedVcDeps: GatedVcDeps = {
    store,
    scheduler,
    providerCache,
    collectVc,
    resolveRepoFullName,
    cachedProvider,
  };

  return async (workspaceId: string): Promise<WorkspaceCockpitSummary | null> => {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) return null;
    const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) return null;
    const ciKey = githubCiCacheKey(
      workspace,
      repo,
      resolveRepoFullName(repo.id),
      store.getWorkspacePrSnapshot(workspace.id),
    );
    const shouldFetchCi = ghAutomationEnabled && shouldFetchGithubCi(store, workspace);
    const [git, versionControlRaw, ci, issueTracker, apps] = await Promise.all([
      cachedProvider(`git:${workspace.id}:${workspace.updatedAt}`, () => readWorkspaceGitStatus(workspace.path), 3000),
      ghAutomationEnabled
        ? fetchVersionControlGated(gatedVcDeps, workspace, repo, `vc:${workspace.id}:${workspace.updatedAt}`)
        : Promise.resolve(disabledVersionControlSummary(workspace, repo)),
      shouldFetchCi
        ? cachedProvider(ciKey, () => providers.collectGitHubCiRuns(workspace.path), 60_000)
        : Promise.resolve(
            cachedCiOrDisabled(
              providerCache,
              ciKey,
              ghAutomationEnabled
                ? "GitHub CI is cached until the PR receives a new local commit"
                : AUTOMATED_GH_DISABLED_REASON,
            ),
          ),
      workspace.issueKey
        ? cachedProvider(`issue:${workspace.issueKey}`, () =>
            providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
          )
        : Promise.resolve(null),
      cachedProvider(
        `apps:${workspace.id}:${workspace.updatedAt}`,
        () => operations.discoverWorkspaceApps({ repo, workspace }),
        60_000,
      ),
    ]);
    const versionControl = decorateWithCooldown(versionControlRaw);
    return {
      workspaceId: workspace.id,
      readiness: deriveReadiness({
        workspace,
        sessions: store.listSessions(workspace.id),
        operations: store.listOperations().filter((operation) => operation.workspaceId === workspace.id),
        providerHealth: await cachedProviderHealth(),
        git,
        versionControl,
        ci,
        apps,
      }),
      git,
      versionControl,
      ci,
      issueTracker,
      apps,
    };
  };
}
