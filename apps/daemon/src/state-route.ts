import type { CitadelConfig } from "@citadel/config";
import type { ProviderHealth } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus } from "@citadel/mcp";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";
import { getBootRestoreSummary } from "./boot-restore.js";
import type { registerScheduledAgentRoutes } from "./scheduled-agent-routes.js";

type ScheduledAgentRunner = ReturnType<typeof registerScheduledAgentRoutes>["runner"];

export function registerStateRoute(input: {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  scheduledAgents: ScheduledAgentRunner;
  daemonStartedAt: string;
  cachedProviderHealth: () => Promise<ProviderHealth[]>;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, store, config, scheduledAgents, daemonStartedAt, cachedProviderHealth, asyncRoute } = input;
  app.get(
    "/api/state",
    asyncRoute(async (_req, res) => {
      const repos = store.listRepos();
      const workspaces = store.listWorkspaces();
      const checkouts = workspaces.flatMap((workspace) => store.listWorkspaceCheckouts(workspace.id));
      const workspacePlans = workspaces.flatMap((workspace) => store.listWorkspacePlanVersions(workspace.id));
      const workspaceManagers = workspaces
        .map((workspace) => store.getWorkspaceManager(workspace.id))
        .filter((manager) => manager !== null);
      const planDeviations = workspaces.flatMap((workspace) => store.listPlanDeviationReports(workspace.id));
      const sessions = store.listWorkspaceSessions();
      const providerHealth = await cachedProviderHealth();
      res.json({
        repos,
        workspaces,
        checkouts,
        workspacePlans,
        workspaceManagers,
        planDeviations,
        sessions,
        operations: store.listOperations(),
        activity: store.listActivity(),
        providerHealth,
        agentRuntimes: listRuntimeHealth(config.agentRuntimes),
        terminal: config.terminal,
        mcp: mcpStatus(config.mcp.enabled),
        scheduledAgents: scheduledAgents.list(),
        namespaces: store.listNamespaces(),
        daemonStartedAt,
        bootRestore: getBootRestoreSummary(),
      });
    }),
  );
}
