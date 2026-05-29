import type {
  CiProviderSummary,
  IssueTrackerSummary,
  ProviderHealth,
  Repo,
  VersionControlSummary,
  Workspace,
  WorkspaceCockpitSummary,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type {
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectJiraIssueSummary,
} from "@citadel/providers";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";
import {
  AUTOMATED_GH_DISABLED_REASON,
  cachedCiOrDisabled,
  disabledVersionControlSummary,
  githubCiCacheKey,
  shouldFetchGithubCi,
} from "./gh-automation.js";
import { decorateWithCooldown } from "./gh-quota-wiring.js";
import { appsCacheKey, ciCacheKey, gitCacheKey, issueCacheKey, vcCacheKey } from "./provider-cache.js";
import { deriveReadiness } from "./readiness.js";
import { readWorkspaceGitStatus } from "./workspace-diff.js";

type Providers = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
};

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;

type ProviderCache = Map<string, { expiresAt: number; value: unknown; cachedAt?: number }>;

export type BuildWorkspaceCockpitSummary = (workspaceId: string) => Promise<WorkspaceCockpitSummary | null>;

export function createWorkspaceCockpitSummaryBuilder(input: {
  store: SqliteStore;
  operations: OperationService;
  providers: Providers;
  providerCache: ProviderCache;
  cachedProvider: CachedProvider;
  cachedProviderSwr: CachedProvider;
  cachedProviderHealth: () => Promise<ProviderHealth[]>;
  ghAutomationEnabled: boolean;
  resolveRepoFullName: (repoId: string) => string | null;
  fetchVersionControl: (workspace: Workspace, repo: Repo, cacheKey: string) => Promise<VersionControlSummary>;
}): BuildWorkspaceCockpitSummary {
  const {
    store,
    operations,
    providers,
    providerCache,
    cachedProvider,
    cachedProviderSwr,
    cachedProviderHealth,
    ghAutomationEnabled,
    resolveRepoFullName,
    fetchVersionControl,
  } = input;

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
      cachedProvider(
        gitCacheKey(workspace.id, workspace.updatedAt),
        () => readWorkspaceGitStatus(workspace.path),
        3000,
      ),
      ghAutomationEnabled
        ? fetchVersionControl(workspace, repo, vcCacheKey(workspace.id, workspace.updatedAt))
        : Promise.resolve(disabledVersionControlSummary(workspace, repo)),
      shouldFetchCi
        ? cachedProviderSwr<CiProviderSummary>(ciKey, () => providers.collectGitHubCiRuns(workspace.path), 60_000)
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
        ? cachedProviderSwr<IssueTrackerSummary>(issueCacheKey(workspace.issueKey), () =>
            providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
          )
        : Promise.resolve(null),
      cachedProvider(
        appsCacheKey(workspace.id, workspace.updatedAt),
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

export function registerCockpitSummaryRoute(input: {
  app: express.Express;
  buildWorkspaceCockpitSummary: BuildWorkspaceCockpitSummary;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, buildWorkspaceCockpitSummary, asyncRoute } = input;
  app.get(
    "/api/workspaces/:workspaceId/cockpit-summary",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const summary = await buildWorkspaceCockpitSummary(workspaceId);
      if (!summary) return res.status(404).json({ error: "workspace_not_found" });
      res.json(summary);
    }),
  );
}
