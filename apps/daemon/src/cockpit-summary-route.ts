import type {
  CiProviderSummary,
  IssueTrackerSummary,
  ProviderHealth,
  VersionControlSummary,
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
import { deriveReadiness } from "./readiness.js";
import { readWorkspaceGitStatus } from "./workspace-diff.js";

type Providers = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
};

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;

export function registerCockpitSummaryRoute(input: {
  app: express.Express;
  store: SqliteStore;
  operations: OperationService;
  providers: Providers;
  cachedProvider: CachedProvider;
  cachedProviderHealth: () => Promise<ProviderHealth[]>;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, store, operations, providers, cachedProvider, cachedProviderHealth, asyncRoute } = input;
  app.get(
    "/api/workspaces/:workspaceId/cockpit-summary",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });

      const [git, versionControl, ci, issueTracker, apps] = await Promise.all([
        cachedProvider(
          `git:${workspace.id}:${workspace.updatedAt}`,
          () => readWorkspaceGitStatus(workspace.path),
          3000,
        ),
        cachedProvider<VersionControlSummary>(`vc:${workspace.id}:${workspace.updatedAt}`, () =>
          providers.collectGitHubVersionControlSummary(workspace.path),
        ),
        cachedProvider<CiProviderSummary>(`ci:${workspace.id}:${workspace.updatedAt}`, () =>
          providers.collectGitHubCiRuns(workspace.path),
        ),
        workspace.issueKey
          ? cachedProvider<IssueTrackerSummary>(`issue:${workspace.issueKey}`, () =>
              providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
            )
          : Promise.resolve(null),
        cachedProvider(
          `apps:${workspace.id}:${workspace.updatedAt}`,
          () => operations.discoverWorkspaceApps({ repo, workspace }),
          60_000,
        ),
      ]);
      const summary: WorkspaceCockpitSummary = {
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
      res.json(summary);
    }),
  );
}
