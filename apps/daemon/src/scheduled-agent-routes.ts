import type http from "node:http";
import type { CitadelConfig } from "@citadel/config";
import { CreateScheduledAgentInputSchema, UpdateScheduledAgentInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type OperationService, ScheduledAgentRunner, createBackgroundAgentSession } from "@citadel/operations";
import { findClaudeTranscriptForSession, renderClaudeTranscriptAsText } from "@citadel/runtimes";
import { killTmuxSession, pipePaneLogPath } from "@citadel/terminal";
import type express from "express";
import { LOG_SLICE_DEFAULT_BYTES, readLogSlice } from "./log-slice.js";
import { ScheduledAgentService } from "./scheduled-agent-service.js";

/**
 * Strict query-string integer parser. Distinguishes "not provided" (uses
 * default) from "provided but invalid" (400) so the public API doesn't
 * silently coerce garbage into a server-chosen default.
 */
function parseQueryInt(
  raw: unknown,
  bounds: { default: number; min: number; max?: number },
): { kind: "ok"; value: number } | { kind: "error"; error: string } {
  if (raw === undefined || raw === null || raw === "") return { kind: "ok", value: bounds.default };
  const str = Array.isArray(raw) ? String(raw[0]) : String(raw);
  if (!/^-?\d+$/.test(str)) return { kind: "error", error: "invalid_integer" };
  const value = Number.parseInt(str, 10);
  if (!Number.isFinite(value) || value < bounds.min) return { kind: "error", error: "out_of_range" };
  if (bounds.max !== undefined && value > bounds.max) return { kind: "error", error: "out_of_range" };
  return { kind: "ok", value };
}

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
    const limit = parseQueryInt(req.query.limit, { default: 50, min: 1, max: 500 });
    if (limit.kind === "error") return res.status(400).json({ error: limit.error, field: "limit" });
    const offset = parseQueryInt(req.query.offset, { default: 0, min: 0 });
    if (offset.kind === "error") return res.status(400).json({ error: offset.error, field: "offset" });
    const runs = store.listScheduledAgentRuns(id, { limit: limit.value, offset: offset.value });
    res.json({ runs });
  });

  app.get("/api/scheduled-agents/:id/runs/:runId/log", (req, res) => {
    const id = String(req.params.id);
    const runId = String(req.params.runId);
    const run = store.findScheduledAgentRun(runId);
    // 404 if either the run doesn't exist OR doesn't belong to this agent.
    if (!run || run.scheduledAgentId !== id) return res.status(404).json({ error: "run_not_found" });
    const offset = parseQueryInt(req.query.offset, { default: 0, min: 0 });
    if (offset.kind === "error") return res.status(400).json({ error: offset.error, field: "offset" });
    const maxBytes = parseQueryInt(req.query.maxBytes, { default: LOG_SLICE_DEFAULT_BYTES, min: 256, max: 200 * 1024 });
    if (maxBytes.kind === "error") return res.status(400).json({ error: maxBytes.error, field: "maxBytes" });

    // Resolve which on-disk file to read. Background runs pipe directly to
    // run.logFilePath. Workspace runs don't — their output lands in tmux's
    // pipe-pane side-channel log (keyed by tmux session name), which itself
    // lives under tmpdir and may be cleaned across reboots. As a last resort
    // we render the agent runtime's own JSONL transcript (claude-code) into
    // a human-readable conversation. Order:
    //   1. recorded logFilePath (background mode writes here)
    //   2. tmux pipe-pane log via session.tmuxSessionName (workspace mode)
    //   3. runtime transcript via session.workspaceId + session.createdAt
    //      (workspace mode, after the pipe-pane log is gone)
    const candidates: string[] = [];
    const session = run.sessionId
      ? store.listSessions().find((candidate) => candidate.id === run.sessionId)
      : undefined;
    if (run.logFilePath) candidates.push(run.logFilePath);
    if (session?.tmuxSessionName) candidates.push(pipePaneLogPath(session.tmuxSessionName));

    for (const candidate of candidates) {
      const slice = readLogSlice(candidate, { offset: offset.value, maxBytes: maxBytes.value });
      if (!("kind" in slice) && slice.bytesRead > 0) return res.json(slice);
    }

    // Transcript fallback. Only claude-code is supported for now; other
    // runtimes (shell, codex, cursor-agent) fall through to log_file_missing.
    if (session && session.runtimeId === "claude-code") {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
      if (workspace) {
        const transcriptPath = findClaudeTranscriptForSession({
          workspacePath: workspace.path,
          sessionStartedAt: session.createdAt,
        });
        if (transcriptPath) {
          const rendered = renderClaudeTranscriptAsText(transcriptPath);
          if (rendered) {
            const buffer = Buffer.from(rendered, "utf8");
            const start = Math.min(offset.value, buffer.length);
            const length = Math.min(maxBytes.value, Math.max(0, buffer.length - start));
            const slice = buffer.subarray(start, start + length).toString("utf8");
            return res.json({
              content: slice,
              bytesRead: length,
              nextOffset: start + length,
              truncated: start + length < buffer.length,
              source: "transcript",
            });
          }
        }
      }
    }

    return res.status(404).json({ error: "log_file_missing" });
  });

  return { runner: scheduledAgents, service };
}
