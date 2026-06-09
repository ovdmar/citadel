// GET /api/workspaces/pr-state — navigator-wide PR/CI snapshot served
// purely from cache. The background refresh job is the freshness driver;
// this route is intentionally cheap so the navigator can poll it every 30s
// without amplifying /api/state's invalidation domain.

import type { CiProviderSummary, VersionControlSummary, WorkspacePrStateEntry } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type express from "express";
import type { asyncRoute as AsyncRoute, ProviderCache } from "./app-helpers.js";
import { checkoutVcCacheKey, ciCacheKey, vcCacheKey } from "./provider-cache.js";

export function registerWorkspacesPrStateRoute(input: {
  app: express.Express;
  store: SqliteStore;
  providerCache: ProviderCache;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, store, providerCache, asyncRoute } = input;
  app.get(
    "/api/workspaces/pr-state",
    asyncRoute(async (_req, res) => {
      const workspacePrState: Record<string, WorkspacePrStateEntry> = {};
      const checkoutPrState: Record<string, Record<string, WorkspacePrStateEntry>> = {};
      for (const workspace of store.listWorkspaces()) {
        if (workspace.archivedAt) continue;
        const vc = providerCache.get(vcCacheKey(workspace.id, workspace.updatedAt));
        const ci = providerCache.get(ciCacheKey(workspace.id, workspace.updatedAt));
        if (vc || ci) {
          const vcValue = vc?.value as VersionControlSummary | undefined;
          const ciValue = ci?.value as CiProviderSummary | undefined;
          const cachedAtMs = Math.max(vc?.cachedAt ?? 0, ci?.cachedAt ?? 0);
          workspacePrState[workspace.id] = {
            pullRequest: vcValue?.pullRequest ?? null,
            ciRuns: ciValue?.runs ?? [],
            checkedAt: vcValue?.checkedAt ?? null,
            cachedAt: cachedAtMs > 0 ? new Date(cachedAtMs).toISOString() : null,
          };
        }
        const checkouts = store.listWorkspaceCheckouts(workspace.id);
        if (!checkouts.length) continue;
        const entries: Record<string, WorkspacePrStateEntry> = {};
        for (const checkout of checkouts) {
          const checkoutVc = providerCache.get(checkoutVcCacheKey(workspace.id, checkout.id, checkout.updatedAt));
          const checkoutVcValue = checkoutVc?.value as VersionControlSummary | undefined;
          entries[checkout.id] = {
            pullRequest: checkoutVcValue?.pullRequest ?? null,
            ciRuns: [],
            checkedAt: checkoutVcValue?.checkedAt ?? null,
            cachedAt:
              typeof checkoutVc?.cachedAt === "number" && checkoutVc.cachedAt > 0
                ? new Date(checkoutVc.cachedAt).toISOString()
                : null,
          };
        }
        checkoutPrState[workspace.id] = entries;
      }
      res.json({ workspacePrState, checkoutPrState });
    }),
  );
}
