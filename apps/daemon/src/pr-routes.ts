import type { CiProviderSummary, VersionControlSummary, WorkspaceCockpitSummary } from "@citadel/contracts";
import { PrMergeRequestSchema, WorkspaceCockpitSummaryBatchRequestSchema } from "@citadel/contracts/pr-routes";
import type { SqliteStore } from "@citadel/db";
import {
  type collectGitHubCiRunLog,
  type collectGitHubCiRuns,
  type collectGitHubVersionControlSummary,
  fetchCommitChecks,
  getGhCooldown,
  mergePr,
  pLimit,
} from "@citadel/providers";
import type express from "express";
import { ZodError } from "zod";
import { decorateWithCooldown } from "./gh-quota-wiring.js";
import { bustCacheByPrefixes } from "./workspace-fs-watcher.js";

// Cap per-PR per-commit check fetches at the most recent N commits. A 50-commit
// PR otherwise spends 50 gh-api calls per refresh; capping bounds the rate-limit
// footprint and keeps the polling cadence sustainable.
const COMMIT_CHECK_CAP = 10;

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
  buildWorkspaceCockpitSummary: (workspaceId: string) => Promise<WorkspaceCockpitSummary | null>;
}) {
  const { app, store, providers, asyncRoute, cachedProvider, providerCache, buildWorkspaceCockpitSummary } = input;

  // Enrich PR commits with per-sha check rollups. Capped at the most recent N
  // commits to bound gh-api rate-limit pressure. Each per-sha lookup is cached
  // for 60s under `commit-checks:${nameWithOwner}:${sha}` so successive polls
  // mostly hit cache. Failures degrade to empty checks (per-PR display still
  // works; missing checks just render as neutral dots).
  async function enrichCommitChecks(
    workspacePath: string,
    summary: WorkspaceCockpitSummary,
  ): Promise<WorkspaceCockpitSummary> {
    const pr = summary.versionControl.pullRequest;
    if (!pr || pr.commits.length === 0) return summary;
    // Derive nameWithOwner from the PR URL — gh's pr-view json gives us the
    // URL but not the headRepository name on the PR object itself. Pattern:
    // https://<host>/<owner>/<repo>/pull/<n>
    const ownerRepoMatch = pr.url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\//);
    if (!ownerRepoMatch) return summary;
    const nameWithOwner = `${ownerRepoMatch[1]}/${ownerRepoMatch[2]}`;
    const limit = pLimit(4);
    const recent = pr.commits.slice(-COMMIT_CHECK_CAP);
    const enriched = await Promise.all(
      recent.map((commit) =>
        limit(() =>
          cachedProvider(
            `commit-checks:${nameWithOwner}:${commit.sha}`,
            () => fetchCommitChecks(workspacePath, nameWithOwner, commit.sha),
            60_000,
          ),
        ),
      ),
    );
    const enrichedBySha = new Map(recent.map((commit, idx) => [commit.sha, enriched[idx] ?? []]));
    return {
      ...summary,
      versionControl: {
        ...summary.versionControl,
        pullRequest: {
          ...pr,
          commits: pr.commits.map((commit) => ({
            ...commit,
            checks: enrichedBySha.get(commit.sha) ?? commit.checks,
          })),
        },
      },
    };
  }

  app.get(
    "/api/repos/:repoId/provider-summary",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const versionControl: VersionControlSummary = await cachedProvider(
        `vc:${repo.id}:${repo.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(repo.rootPath),
        60_000,
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
        60_000,
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
              const enriched = await enrichCommitChecks(workspace.path, summary);
              return { workspaceId, ok: true as const, summary: enriched };
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
      // During gh cooldown, skip the cache-bust + fetch — serve whatever's in
      // cache decorated with cooldownUntil so the FE banner can render. No 503;
      // the response shape stays uniform across cooldown / normal.
      if (!getGhCooldown()) {
        bustCacheByPrefixes(providerCache, [`vc:${workspace.id}`, `ci:${workspace.id}`]);
      }
      const versionControl: VersionControlSummary = await cachedProvider(
        `vc:${workspace.id}:${workspace.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(workspace.path),
        60_000,
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
      let parsed: { strategy: "squash" | "merge" | "rebase" };
      try {
        parsed = PrMergeRequestSchema.parse(req.body);
      } catch (error) {
        if (error instanceof ZodError) return res.status(400).json({ error: "invalid_merge_request" });
        throw error;
      }
      const summary = await cachedProvider(
        `vc:${workspace.id}:${workspace.updatedAt}`,
        () => providers.collectGitHubVersionControlSummary(workspace.path),
        60_000,
      );
      const number = summary.pullRequest?.number;
      if (typeof number !== "number")
        return res.status(409).json({ ok: false, reason: "no_pr", detail: "Workspace has no open PR" });
      const result = await mergePr({ rootPath: workspace.path, number, strategy: parsed.strategy });
      if (result.ok) bustCacheByPrefixes(providerCache, [`vc:${workspace.id}`, `ci:${workspace.id}`]);
      res.status(result.ok ? 200 : 409).json(result);
    }),
  );
}
