import type {
  CiProviderSummary,
  PullRequestSummary,
  VersionControlSummary,
  WorkspaceCockpitSummary,
} from "@citadel/contracts";
import { PrMergeRequestSchema, WorkspaceCockpitSummaryBatchRequestSchema } from "@citadel/contracts/pr-routes";
import type { SqliteStore } from "@citadel/db";
import {
  type collectGitHubCiRunLog,
  type collectGitHubCiRuns,
  type collectGitHubVersionControlSummary,
  getGhCooldown,
  mergePr,
  pLimit,
} from "@citadel/providers";
import type express from "express";
import { ZodError } from "zod";
import { buildVersionControlProviderDeps, decorateWithCooldown } from "./gh-quota-wiring.js";
import { globalPrCacheKey, globalPrCacheKeyForWorkspace, writeGlobalPrSummary } from "./global-pr-cache.js";
import { bustCacheByPrefixes } from "./workspace-fs-watcher.js";

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

type ProviderCache = Map<string, { expiresAt: number; value: unknown }>;

const VC_PROVIDER_CACHE_TTL_MS = 90_000;

// Repo-level PR/CI routes + workspace-level batch poll, force-refresh, and
// merge endpoints.
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
  providerCache: ProviderCache;
  resolveRepoFullName: (repoId: string) => string | null;
  buildWorkspaceCockpitSummary: (workspaceId: string) => Promise<WorkspaceCockpitSummary | null>;
}) {
  const {
    app,
    store,
    providers,
    asyncRoute,
    cachedProvider,
    providerCache,
    resolveRepoFullName,
    buildWorkspaceCockpitSummary,
  } = input;
  const providerDepsForRepo = (repoId: string) =>
    buildVersionControlProviderDeps(providerCache, () => resolveRepoFullName(repoId));

  app.get(
    "/api/repos/:repoId/provider-summary",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const versionControl: VersionControlSummary = await cachedProvider(
        `vc:${repo.id}:${repo.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(repo.rootPath, providerDepsForRepo(repo.id)),
        VC_PROVIDER_CACHE_TTL_MS,
      );
      res.json({ versionControl: decorateWithCooldown(versionControl) });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const ci: CiProviderSummary = await cachedProvider(
        `ci:${repo.id}:${repo.updatedAt}`,
        () => providers.collectGitHubCiRuns(repo.rootPath),
        180_000,
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

  // Batch endpoint for the always-on cross-workspace PR poll. Daemon fans out
  // to up to 4 workspaces in parallel; root workspaces and workspaces with no
  // remote are rejected cheaply (no gh spawn) via the per-workspace envelope.
  // POST with JSON body avoids 414 on operators with many workspaces.
  app.post(
    "/api/workspaces/cockpit-summary/batch",
    asyncRoute(async (req, res) => {
      let parsed: { ids: string[] };
      try {
        parsed = WorkspaceCockpitSummaryBatchRequestSchema.parse(req.body);
      } catch (error) {
        if (error instanceof ZodError) return res.status(400).json({ error: "invalid_batch_request" });
        throw error;
      }
      const limit = pLimit(4);
      const summaries = await Promise.all(
        parsed.ids.map((workspaceId) =>
          limit(async () => {
            const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
            if (!workspace) return { workspaceId, ok: false as const, reason: "workspace_not_found" };
            if (workspace.kind === "root") return { workspaceId, ok: false as const, reason: "root-workspace" };
            try {
              const summary = await buildWorkspaceCockpitSummary(workspaceId);
              if (!summary) return { workspaceId, ok: false as const, reason: "workspace_not_found" };
              // Surface remote-less workspaces as a fast-fail envelope so the
              // client doesn't render a "loading" placeholder for them forever.
              if (summary.versionControl.remotes.length === 0)
                return { workspaceId, ok: false as const, reason: "no-remote" };
              return { workspaceId, ok: true as const, summary };
            } catch (error) {
              const reason = error instanceof Error ? error.message : "summary_failed";
              return { workspaceId, ok: false as const, reason };
            }
          }),
        ),
      );
      res.json({ summaries });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/pr-refresh",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      // During gh cooldown, skip the cache-bust + fetch — serve whatever's in
      // cache decorated with cooldownUntil so the FE banner can render. No 503;
      // the response shape stays uniform across cooldown / normal.
      if (!getGhCooldown()) {
        const nameWithOwner = resolveRepoFullName(repo.id);
        bustCacheByPrefixes(
          providerCache,
          [`vc:${workspace.id}`, `ci:${repo.id}`, nameWithOwner ? `ci:${nameWithOwner}` : null].filter(
            Boolean,
          ) as string[],
        );
        const key = globalPrCacheKeyForWorkspace(workspace, {
          resolveRepoFullName,
          getSnapshot: (id) => store.getWorkspacePrSnapshot(id),
        });
        if (key) providerCache.delete(key);
      }
      const versionControl: VersionControlSummary = await cachedProvider(
        `vc:${workspace.id}:${workspace.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(workspace.path, providerDepsForRepo(repo.id)),
        VC_PROVIDER_CACHE_TTL_MS,
      );
      res.json({ versionControl: decorateWithCooldown(versionControl) });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/pr-merge",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      let parsed: { strategy: "squash" | "merge" | "rebase" };
      try {
        parsed = PrMergeRequestSchema.parse(req.body);
      } catch (error) {
        if (error instanceof ZodError) return res.status(400).json({ error: "invalid_merge_request" });
        throw error;
      }
      const summary = await cachedProvider(
        `vc:${workspace.id}:${workspace.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(workspace.path, providerDepsForRepo(repo.id)),
        VC_PROVIDER_CACHE_TTL_MS,
      );
      const pr = summary.pullRequest;
      const number = pr?.number;
      if (!pr || typeof number !== "number")
        return res.status(409).json({ ok: false, reason: "no_pr", detail: "Workspace has no open PR" });
      const result = await mergePr({ rootPath: workspace.path, number, strategy: parsed.strategy });
      const nameWithOwner = resolveRepoFullName(repo.id);
      if (result.ok) {
        const mergedPr = markPullRequestMerged(pr);
        const checkedAt = new Date().toISOString();
        const mergedVersionControl: VersionControlSummary = {
          ...summary,
          pullRequest: mergedPr,
          checkedAt,
        };
        providerCache.set(`vc:${workspace.id}:${workspace.updatedAt}`, {
          expiresAt: Date.now() + VC_PROVIDER_CACHE_TTL_MS,
          value: mergedVersionControl,
        });
        if (nameWithOwner) writeGlobalPrSummary(providerCache, globalPrCacheKey(nameWithOwner, number), mergedPr);
        store.updateWorkspacePrSnapshot(workspace.id, {
          prNumber: number,
          prState: "merged",
          lastFetchAt: checkedAt,
          lastChecksGreenAt: allChecksGreen(mergedPr) ? checkedAt : null,
          lastHeadSha: mergedPr.headSha ?? null,
          lastMergeStateStatus: mergedPr.mergeStateStatus ?? null,
        });
        bustCacheByPrefixes(
          providerCache,
          [`ci:${repo.id}`, nameWithOwner ? `ci:${nameWithOwner}` : null].filter(Boolean) as string[],
        );
      } else if (nameWithOwner && isMergeStrategyCacheFailure(result.reason, result.detail)) {
        providerCache.delete(`gh-repo-merge-strategies:${nameWithOwner}`);
      }
      res.status(result.ok ? 200 : 409).json(result);
    }),
  );
}

function markPullRequestMerged(pr: PullRequestSummary): PullRequestSummary {
  return {
    ...pr,
    state: "MERGED",
    mergeable: "unknown",
    allowedMergeStrategies: [],
    mergeStateStatus: null,
  };
}

function allChecksGreen(pr: PullRequestSummary): boolean {
  return (
    pr.checks.length > 0 &&
    pr.checks.every((check) => {
      const conclusion = (check.conclusion ?? "").toLowerCase();
      return conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";
    })
  );
}

function isMergeStrategyCacheFailure(reason: string, detail: string): boolean {
  return reason === "strategy_disallowed" || /merge method|strategy|not allowed/i.test(detail);
}
