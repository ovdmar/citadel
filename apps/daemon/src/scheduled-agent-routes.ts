import type http from "node:http";
import type { CitadelConfig } from "@citadel/config";
import { CreateScheduledAgentInputSchema, UpdateScheduledAgentInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type OperationService, ScheduledAgentRunner } from "@citadel/operations";
import type express from "express";
import { ScheduledAgentService } from "./scheduled-agent-service.js";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export type ScheduledAgentBundle = {
  runner: ScheduledAgentRunner;
  service: ScheduledAgentService;
};

export function registerScheduledAgentRoutes(input: {
  app: express.Express;
  server: http.Server;
  store: SqliteStore;
  operations: OperationService;
  config: CitadelConfig;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: AsyncRoute;
}): ScheduledAgentBundle {
  const { app, server, store, operations, config, emit, asyncRoute } = input;
  const scheduledAgents = new ScheduledAgentRunner({
    store,
    operations,
    getRuntime: (runtimeId) => config.runtimes.find((runtime) => runtime.id === runtimeId),
    recordActivity: (event) => {
      store.addActivity({
        id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        type: event.type,
        source: "system",
        repoId: event.repoId,
        workspaceId: event.workspaceId,
        operationId: null,
        message: event.message,
        hookOutput: null,
        createdAt: new Date().toISOString(),
      });
    },
  });

  if (process.env.CITADEL_DISABLE_SCHEDULER !== "1") {
    const interval = setInterval(() => {
      scheduledAgents
        .tick()
        .then((fired) => {
          if (fired.length) emit("scheduled-agent.run", { fired });
        })
        .catch(() => {});
    }, 30_000);
    interval.unref();
    server.on("close", () => clearInterval(interval));
  }

  app.get("/api/scheduled-agents", (_req, res) => {
    res.json({ scheduledAgents: scheduledAgents.list() });
  });

  const service = new ScheduledAgentService(scheduledAgents, emit);

  app.post(
    "/api/scheduled-agents",
    asyncRoute(async (req, res) => {
      const parsed = CreateScheduledAgentInputSchema.parse(req.body);
      const result = service.create(parsed);
      if (!result.ok) return res.status(400).json({ error: result.error });
      res.status(201).json({ scheduledAgent: result.value });
    }),
  );

  app.patch(
    "/api/scheduled-agents/:id",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const parsed = UpdateScheduledAgentInputSchema.parse(req.body);
      const result = service.update(id, parsed);
      if (!result.ok) {
        const status = result.error === "scheduled_agent_not_found" ? 404 : 400;
        return res.status(status).json({ error: result.error });
      }
      res.json({ scheduledAgent: result.value });
    }),
  );

  app.delete("/api/scheduled-agents/:id", (req, res) => {
    const id = String(req.params.id);
    const result = service.delete(id);
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.status(202).json({ removed: true });
  });

  app.post(
    "/api/scheduled-agents/:id/run",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const result = await service.runNow(id);
      if (!result.ok) return res.status(404).json({ error: result.error });
      const { status, message, workspaceId, sessionId, scheduledAgent } = result.value;
      res.status(status === "succeeded" ? 202 : 424).json({
        status,
        message,
        workspaceId,
        sessionId,
        scheduledAgent,
      });
    }),
  );

  return { runner: scheduledAgents, service };
}
