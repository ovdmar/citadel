import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus } from "@citadel/mcp";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { asyncRoute as asyncRouteHelper } from "./app-helpers.js";
import { getBootRestoreSummary } from "./boot-restore.js";

export function registerDaemonStateRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  store: SqliteStore;
  asyncRoute: typeof asyncRouteHelper;
  cachedProviderHealth: () => Promise<Array<{ status: string; reason: string | null }>>;
  listScheduledAgents: () => unknown;
}): void {
  const { app, config, store, asyncRoute, cachedProviderHealth, listScheduledAgents } = input;

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const providerHealth = await cachedProviderHealth();
      const degradedProviders = providerHealth.filter((provider) => provider.status !== "healthy");
      res.json({
        ok: true,
        app: "citadel",
        mode: "local-first",
        databasePath: config.databasePath,
        degradedProviders: degradedProviders.length,
        providerHealth,
        mcp: mcpStatus(config.mcp.enabled),
        now: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/state",
    asyncRoute(async (_req, res) => {
      const repos = store.listRepos();
      const workspaces = store.listWorkspaces();
      const sessions = store.listSessions();
      const providerHealth = await cachedProviderHealth();
      res.json({
        repos,
        workspaces,
        sessions,
        operations: store.listOperations(),
        activity: store.listActivity(),
        providerHealth,
        runtimes: listRuntimeHealth(config.runtimes),
        mcp: mcpStatus(config.mcp.enabled),
        scheduledAgents: listScheduledAgents(),
        namespaces: store.listNamespaces(),
        bootRestore: getBootRestoreSummary(),
      });
    }),
  );
}
