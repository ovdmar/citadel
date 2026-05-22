import type http from "node:http";
import type { CitadelConfig } from "@citadel/config";
import { CreateScheduledAgentInputSchema, UpdateScheduledAgentInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type OperationService, ScheduledAgentRunner } from "@citadel/operations";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

export function registerScheduledAgentRoutes(input: {
  app: express.Express;
  server: http.Server;
  store: SqliteStore;
  operations: OperationService;
  config: CitadelConfig;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: AsyncRoute;
}): ScheduledAgentRunner {
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

  app.post(
    "/api/scheduled-agents",
    asyncRoute(async (req, res) => {
      const parsed = CreateScheduledAgentInputSchema.parse(req.body);
      try {
        const agent = scheduledAgents.create(parsed);
        emit("scheduled-agent.updated", { id: agent.id, agent });
        res.status(201).json({ scheduledAgent: agent });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "scheduled_agent_create_failed" });
      }
    }),
  );

  app.patch(
    "/api/scheduled-agents/:id",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const parsed = UpdateScheduledAgentInputSchema.parse(req.body);
      try {
        const agent = scheduledAgents.update(id, parsed);
        if (!agent) return res.status(404).json({ error: "scheduled_agent_not_found" });
        emit("scheduled-agent.updated", { id: agent.id, agent });
        res.json({ scheduledAgent: agent });
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "scheduled_agent_update_failed" });
      }
    }),
  );

  app.delete("/api/scheduled-agents/:id", (req, res) => {
    const id = String(req.params.id);
    const removed = scheduledAgents.delete(id);
    if (!removed) return res.status(404).json({ error: "scheduled_agent_not_found" });
    emit("scheduled-agent.updated", { id, removed: true });
    res.status(202).json({ removed: true });
  });

  app.post(
    "/api/scheduled-agents/:id/run",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const agent = scheduledAgents.find(id);
      if (!agent) return res.status(404).json({ error: "scheduled_agent_not_found" });
      const result = await scheduledAgents.runOnce(id);
      emit("scheduled-agent.run", { id, status: result.status });
      res.status(result.status === "succeeded" ? 202 : 424).json({
        status: result.status,
        message: result.message,
        workspaceId: result.workspaceId,
        sessionId: result.sessionId,
        scheduledAgent: scheduledAgents.find(id),
      });
    }),
  );

  return scheduledAgents;
}
