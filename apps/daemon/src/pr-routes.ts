import type { CiProviderSummary, VersionControlSummary } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type {
  collectGitHubCiRunLog,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
} from "@citadel/providers";
import type express from "express";

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectGitHubCiRunLog: typeof collectGitHubCiRunLog;
};

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

type CachedProvider = <T>(key: string, load: () => T | Promise<T>, ttlMs?: number) => Promise<T>;

// Repo-level PR/CI routes. Workspace-level PR/CI surfaces (cockpit-summary,
// pr-refresh, pr-merge, batch) live alongside this module — see the new
// endpoints registered by registerPrRoutes for the batch + merge flow.
//
// Caching boundary with #15: keys use the established `vc:` / `ci:` prefixes
// and go through the daemon's cachedProvider helper. #15 may later replace
// the in-memory map with a richer caching layer; we depend only on
// cachedProvider(key, fn, ttl?) and bustCacheByPrefixes(cache, prefixes).
export function registerPrRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  providers: ProviderCollectors;
  asyncRoute: AsyncRoute;
  cachedProvider: CachedProvider;
}) {
  const { app, store, providers, asyncRoute, cachedProvider } = input;

  app.get(
    "/api/repos/:repoId/provider-summary",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const versionControl: VersionControlSummary = await cachedProvider(`vc:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubVersionControlSummary(repo.rootPath),
      );
      res.json({ versionControl });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const ci: CiProviderSummary = await cachedProvider(`ci:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubCiRuns(repo.rootPath),
      );
      res.json({ ci });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs/:runId/logs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      const runId = req.params.runId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      if (typeof runId !== "string") return res.status(400).json({ error: "run_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const log = await providers.collectGitHubCiRunLog(repo.rootPath, runId);
      res.json({ log });
    }),
  );
}
