import type http from "node:http";
import type { CitadelConfig } from "@citadel/config";
import { CreateScheduledAgentInputSchema, UpdateScheduledAgentInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type OperationService, ScheduledAgentRunner, createBackgroundAgentSession } from "@citadel/operations";
import { killTmuxSession } from "@citadel/terminal";
import type express from "express";
import { LOG_SLICE_DEFAULT_BYTES, readLogSlice } from "./log-slice.js";
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
  const recordActivity = (event: {
    type: string;
    message: string;
    repoId: string | null;
    workspaceId: string | null;
  }) => {
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
  };
  const scheduledAgents = new ScheduledAgentRunner({
    store,
    operations,
    getRuntime: (runtimeId) => config.runtimes.find((runtime) => runtime.id === runtimeId),
    dataDir: config.dataDir,
    createBackgroundSession: (input) =>
      createBackgroundAgentSession(
        {
          store,
          activity: (type, source, message, repoId, workspaceId, operationId) =>
            store.addActivity({
              id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
              type,
              source,
              repoId,
              workspaceId,
              operationId,
              message,
              hookOutput: null,
              createdAt: new Date().toISOString(),
            }),
        },
        input,
      ),
    killTmuxSession: (name) => killTmuxSession(name),
    recordActivity,
    emitRunRow: (event) => emit("scheduled-agent.run-row", event),
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
    if (!result.ok) {
      const status = result.error === "in_flight_run" ? 409 : 404;
      return res.status(status).json({ error: result.error });
    }
    res.status(202).json({ removed: true });
  });

  app.post(
    "/api/scheduled-agents/:id/run",
    asyncRoute(async (req, res) => {
      const id = String(req.params.id);
      const result = await service.runNow(id);
      if (!result.ok) return res.status(404).json({ error: result.error });
      const value = result.value;
      const scheduledAgent = value.scheduledAgent;
      if (value.kind === "ran") {
        return res.status(value.status === "succeeded" ? 202 : 424).json({
          status: value.status,
          runId: value.runId,
          message: value.message,
          workspaceId: value.workspaceId,
          sessionId: value.sessionId,
          backgroundSessionId: value.backgroundSessionId,
          scheduledAgent,
        });
      }
      if (value.kind === "queued") {
        return res.status(202).json({
          queued: true,
          runId: value.runId,
          queuePosition: value.queuePosition,
          scheduledAgent,
        });
      }
      if (value.kind === "skipped_overlap") {
        return res.status(409).json({ error: "run_already_in_progress", scheduledAgent });
      }
      // queue_full
      res.status(429).json({ error: "queue_full", limit: value.limit, scheduledAgent });
    }),
  );

  app.get("/api/scheduled-agents/:id/runs", (req, res) => {
    const id = String(req.params.id);
    if (!scheduledAgents.find(id)) return res.status(404).json({ error: "scheduled_agent_not_found" });
    const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? "50"), 10) || 50, 500));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? "0"), 10) || 0);
    const runs = store.listScheduledAgentRuns(id, { limit, offset });
    res.json({ runs });
  });

  app.get("/api/scheduled-agents/:id/runs/:runId/log", (req, res) => {
    const id = String(req.params.id);
    const runId = String(req.params.runId);
    const run = store.findScheduledAgentRun(runId);
    // 404 if either the run doesn't exist OR doesn't belong to this agent.
    if (!run || run.scheduledAgentId !== id) return res.status(404).json({ error: "run_not_found" });
    if (!run.logFilePath) return res.status(404).json({ error: "log_not_available" });
    const offset = Number.parseInt(String(req.query.offset ?? "0"), 10) || 0;
    const maxBytes =
      Number.parseInt(String(req.query.maxBytes ?? LOG_SLICE_DEFAULT_BYTES), 10) || LOG_SLICE_DEFAULT_BYTES;
    const slice = readLogSlice(run.logFilePath, { offset, maxBytes });
    if ("kind" in slice) return res.status(404).json({ error: "log_file_missing" });
    res.json(slice);
  });

  return { runner: scheduledAgents, service };
}
