import type { CitadelConfig } from "@citadel/config";
import type { ProviderHealth } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus } from "@citadel/mcp";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";
import type { registerScheduledAgentRoutes } from "./scheduled-agent-routes.js";

type ScheduledAgentRunner = ReturnType<typeof registerScheduledAgentRoutes>["runner"];

export function registerStateRoute(input: {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  scheduledAgents: ScheduledAgentRunner;
  cachedProviderHealth: () => Promise<ProviderHealth[]>;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, store, config, scheduledAgents, cachedProviderHealth, asyncRoute } = input;
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
        scheduledAgents: scheduledAgents.list(),
        namespaces: store.listNamespaces(),
      });
    }),
  );
}
