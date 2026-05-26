import type { CitadelConfig } from "@citadel/config";
import {
  AgentsConfigSchema,
  CreateAgentDefinitionInputSchema,
  type RuntimeModelsResponse,
  UpdateAgentDefinitionInputSchema,
} from "@citadel/contracts";
import { type RuntimeModelLister, type RuntimeModelListerResult, runtimeModelListers } from "@citadel/runtimes";
import type express from "express";
import {
  AgentDefinitionsError,
  type AgentDefinitionsStorage,
  createAgentDefinitionsStorage,
} from "./agent-definitions/storage.js";

const MODELS_TTL_MS = 60 * 60 * 1_000;

export type AgentsRoutesDeps = {
  app: express.Express;
  asyncRoute: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
  ) => express.RequestHandler;
  agentDefinitions: AgentDefinitionsStorage;
  // Map of runtimeId → { command, args, lister }. The daemon owns the
  // resolution from runtime config; the route layer is just a thin shim.
  runtimes: () => Array<{ id: string; command: string; args: string[] }>;
  modelListers?: Record<string, RuntimeModelLister> | undefined;
  now?: (() => number) | undefined;
};

type ModelsCacheEntry = {
  result: RuntimeModelsResponse;
  at: number;
};

export function registerAgentsRoutes(deps: AgentsRoutesDeps) {
  const { app, asyncRoute, agentDefinitions, runtimes, now = () => Date.now() } = deps;
  const modelListers: Record<string, RuntimeModelLister> = deps.modelListers ?? {};
  const modelsCache = new Map<string, ModelsCacheEntry>();

  const ensureReady = (res: express.Response): boolean => {
    if (agentDefinitions.state() === "unavailable") {
      res.status(503).json({ error: "agent_storage_unavailable" });
      return false;
    }
    return true;
  };

  const mapErrorToStatus = (code: AgentDefinitionsError["code"]): number => {
    switch (code) {
      case "agent_storage_unavailable":
        return 503;
      case "predefined_agent_cannot_be_deleted":
        return 409;
      case "predefined_agent_cannot_be_reset_by_custom_id":
      case "custom_agent_cannot_reuse_predefined_id":
        return 400;
      case "agent_not_found":
        return 404;
      case "name_collides":
        return 409;
      default:
        return 500;
    }
  };

  const sendStorageError = (res: express.Response, err: unknown) => {
    if (err instanceof AgentDefinitionsError) {
      res.status(mapErrorToStatus(err.code)).json({ error: err.code });
      return;
    }
    throw err;
  };

  app.get(
    "/api/agents",
    asyncRoute(async (_req, res) => {
      if (!ensureReady(res)) return;
      const definitions = agentDefinitions.list();
      const config = agentDefinitions.readConfig();
      res.json({ definitions, config });
    }),
  );

  app.post(
    "/api/agents",
    asyncRoute(async (req, res) => {
      if (!ensureReady(res)) return;
      const input = CreateAgentDefinitionInputSchema.parse(req.body);
      try {
        const def = agentDefinitions.create(input);
        res.status(201).json({ definition: def });
      } catch (err) {
        sendStorageError(res, err);
      }
    }),
  );

  app.patch(
    "/api/agents/:id",
    asyncRoute(async (req, res) => {
      if (!ensureReady(res)) return;
      const input = UpdateAgentDefinitionInputSchema.parse(req.body);
      try {
        const def = agentDefinitions.update(String(req.params.id), input);
        res.json({ definition: def });
      } catch (err) {
        sendStorageError(res, err);
      }
    }),
  );

  app.delete(
    "/api/agents/:id",
    asyncRoute(async (req, res) => {
      if (!ensureReady(res)) return;
      try {
        agentDefinitions.remove(String(req.params.id));
        res.status(204).end();
      } catch (err) {
        sendStorageError(res, err);
      }
    }),
  );

  app.post(
    "/api/agents/:id/reset",
    asyncRoute(async (req, res) => {
      if (!ensureReady(res)) return;
      try {
        const def = agentDefinitions.resetToDefaults(String(req.params.id));
        res.json({ definition: def });
      } catch (err) {
        sendStorageError(res, err);
      }
    }),
  );

  app.get(
    "/api/agents/config",
    asyncRoute(async (_req, res) => {
      if (!ensureReady(res)) return;
      res.json({ config: agentDefinitions.readConfig() });
    }),
  );

  app.put(
    "/api/agents/config",
    asyncRoute(async (req, res) => {
      if (!ensureReady(res)) return;
      const input = AgentsConfigSchema.parse(req.body);
      try {
        const config = agentDefinitions.writeConfig(input);
        res.json({ config });
      } catch (err) {
        sendStorageError(res, err);
      }
    }),
  );

  app.get(
    "/api/runtimes/:id/models",
    asyncRoute(async (req, res) => {
      const runtimeId = String(req.params.id ?? "");
      const lister = modelListers[runtimeId];
      if (!lister) {
        res.status(404).json({ error: "runtime_not_supported" });
        return;
      }
      const refresh = String(req.query.refresh ?? "") === "1";
      const cached = modelsCache.get(runtimeId);
      if (!refresh && cached && now() - cached.at < MODELS_TTL_MS) {
        res.json(cached.result);
        return;
      }
      const runtime = runtimes().find((r) => r.id === runtimeId);
      if (!runtime) {
        res.status(404).json({ error: "runtime_not_configured" });
        return;
      }
      let result: RuntimeModelListerResult;
      try {
        result = await lister({ command: runtime.command, args: runtime.args });
      } catch (err) {
        result = {
          models: [],
          probeError: err instanceof Error ? err.message : String(err),
        };
      }
      const response: RuntimeModelsResponse = {
        models: result.models,
        probeError: result.probeError,
      };
      modelsCache.set(runtimeId, { result: response, at: now() });
      res.json(response);
    }),
  );
}

// Wire helper: creates the storage, registers the routes, returns storage so
// the daemon's MCP dispatch can share the same instance.
export function wireAgents(app: express.Express, asyncRoute: AgentsRoutesDeps["asyncRoute"], config: CitadelConfig) {
  const agentDefinitions = createAgentDefinitionsStorage();
  registerAgentsRoutes({
    app,
    asyncRoute,
    agentDefinitions,
    modelListers: runtimeModelListers,
    runtimes: () => config.runtimes.map((r) => ({ id: r.id, command: r.command, args: r.args })),
  });
  return agentDefinitions;
}
