import type { CitadelConfig } from "@citadel/config";
import type { ProviderHealth } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus } from "@citadel/mcp";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import { getBootRestoreSummary } from "./boot-restore.js";

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export function registerStateRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  store: SqliteStore;
  asyncRoute: AsyncRoute;
  providerHealth: () => Promise<ProviderHealth[]>;
  scheduledAgents: { list: () => unknown };
}) {
  const { app, config, store, asyncRoute, providerHealth, scheduledAgents } = input;

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const health = await providerHealth();
      const degradedProviders = health.filter((provider) => provider.status !== "healthy");
      res.json({
        ok: true,
        app: "citadel",
        mode: "local-first",
        databasePath: config.databasePath,
        degradedProviders: degradedProviders.length,
        providerHealth: health,
        mcp: mcpStatus(config.mcp.enabled),
        now: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/state",
    asyncRoute(async (_req, res) => {
      const health = await providerHealth();
      res.json({
        repos: store.listRepos(),
        workspaces: store.listWorkspaces(),
        sessions: store.listSessions(),
        operations: store.listOperations(),
        activity: store.listActivity(),
        providerHealth: health,
        runtimes: listRuntimeHealth(config.runtimes),
        mcp: mcpStatus(config.mcp.enabled),
        scheduledAgents: scheduledAgents.list(),
        namespaces: store.listNamespaces(),
        bootRestore: getBootRestoreSummary(),
      });
    }),
  );

  app.get("/api/runtimes", (_req, res) => {
    res.json({ runtimes: listRuntimeHealth(config.runtimes) });
  });
}
