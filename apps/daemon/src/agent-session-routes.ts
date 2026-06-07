import type { AgentRuntimeConfig, CitadelConfig } from "@citadel/config";
import { CreateAgentSessionInputSchema, CreateTerminalSessionInputSchema } from "@citadel/contracts";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { CreateAgentSessionOperationInput, OperationService } from "@citadel/operations";
import type express from "express";
import { resolveCreateAgentSessionInputFromTemplates } from "./agent-session-template-resolver.js";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => express.RequestHandler;

type Deps = {
  operations: OperationService;
  store: SqliteStore;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: AsyncRoute;
  config: CitadelConfig;
};

/**
 * Read-side and message-side routes for individual agent sessions. The
 * REST surface mirrors the MCP tools so the cockpit UI and external
 * automation share the same backend code path.
 */
export function registerAgentSessionRoutes(app: express.Express, deps: Deps) {
  const { operations, store, emit, asyncRoute, config } = deps;

  app.post(
    "/api/agent-sessions",
    asyncRoute(async (req, res) => {
      const parsed = CreateAgentSessionInputSchema.parse(req.body);
      const input = await resolveCreateAgentSessionInputFromTemplates(config, parsed);
      const runtime = config.agentRuntimes.find((candidate) => candidate.id === input.runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });
      const session = await operations.createAgentSession(input, runtimeDescriptor(runtime));
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/terminal-sessions",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const input = CreateTerminalSessionInputSchema.parse({ ...(req.body ?? {}), workspaceId });
      const session = await operations.createTerminalSession(input);
      emit("terminal.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session });
    }),
  );

  app.delete(
    "/api/agent-sessions/:sessionId",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const result = operations.stopAgentSession({ sessionId });
      if (!result.stopped) return res.status(404).json(result);
      emit("agent.updated", { sessionId });
      res.status(202).json(result);
    }),
  );

  app.delete(
    "/api/workspace-sessions/:sessionId",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const result = operations.stopWorkspaceSession({ sessionId });
      if (!result.stopped) return res.status(404).json(result);
      emit("workspace-session.updated", { sessionId });
      res.status(202).json(result);
    }),
  );

  app.post(
    "/api/agent-sessions/:sessionId/reload",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const source = store.listWorkspaceSessions().find((candidate) => candidate.id === sessionId);
      if (!source) return res.status(404).json({ error: "session_not_found" });
      if (source.kind !== "agent") return res.status(409).json({ error: "session_not_agent" });
      if (source.closedAt) return res.status(409).json({ error: "session_not_live", sessionId: source.id });
      if (!source.runtimeSessionId) {
        return res.status(409).json({ error: "session_not_resumable", sessionId: source.id });
      }
      const runtime = config.agentRuntimes.find((candidate) => candidate.id === source.runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found", runtimeId: source.runtimeId });
      if (!runtime.resumeArg) {
        return res.status(409).json({ error: "runtime_does_not_support_resume", runtimeId: source.runtimeId });
      }

      const stopped = operations.stopAgentSession({ sessionId: source.id });
      if (!stopped.stopped) return res.status(409).json(stopped);
      let session: AgentSession;
      try {
        session = await operations.createAgentSession(reloadInput(source), runtimeDescriptor(runtime));
      } catch (error) {
        emit("agent.updated", { workspaceId: source.workspaceId, sessionId: source.id });
        throw error;
      }
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id, reloadedFrom: source.id });
      res.status(202).json({ session, reloadedFrom: source.id });
    }),
  );

  app.get(
    "/api/agent-sessions/:sessionId/output",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const lines = parseIntQuery(req.query.lines);
      const maxChars = parseIntQuery(req.query.maxChars);
      const input: { sessionId: string; lines?: number; maxChars?: number } = { sessionId };
      if (lines !== undefined) input.lines = lines;
      if (maxChars !== undefined) input.maxChars = maxChars;
      const result = operations.readAgentTranscript(input);
      if (!result.ok) return res.status(result.error === "session_not_found" ? 404 : 409).json(result);
      res.json(result);
    }),
  );

  app.get(
    "/api/agent-sessions/:sessionId/history",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const limit = parseIntQuery(req.query.limit);
      const maxChars = parseIntQuery(req.query.maxChars);
      const input: { sessionId: string; limit?: number; maxChars?: number } = { sessionId };
      if (limit !== undefined) input.limit = limit;
      if (maxChars !== undefined) input.maxChars = maxChars;
      const result = operations.readAgentHistory(input);
      if (!result.ok) return res.status(result.error === "session_not_found" ? 404 : 409).json(result);
      res.json(result);
    }),
  );

  app.post(
    "/api/agent-sessions/:sessionId/messages",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const message = typeof req.body?.message === "string" ? (req.body.message as string) : "";
      if (!message) return res.status(400).json({ error: "message_required" });
      const result = await operations.sendAgentMessage({ sessionId, message });
      if (!result.ok) return res.status(result.error === "session_not_found" ? 404 : 409).json(result);
      emit("agent.updated", { sessionId });
      res.status(202).json(result);
    }),
  );
}

function runtimeDescriptor(runtime: AgentRuntimeConfig) {
  return {
    command: runtime.command,
    args: runtime.args,
    displayName: runtime.displayName,
    promptArg: runtime.promptArg ?? null,
    sessionIdArg: runtime.sessionIdArg ?? null,
    resumeArg: runtime.resumeArg ?? null,
    ...(runtime.launchOptions ? { launchOptions: runtime.launchOptions } : {}),
  };
}

function reloadInput(source: AgentSession): CreateAgentSessionOperationInput {
  return {
    workspaceId: source.workspaceId,
    runtimeId: source.runtimeId,
    displayName: source.displayName,
    resumeRuntimeSessionId: source.runtimeSessionId ?? undefined,
    resumeSourceSessionId: source.id,
    tabId: source.tabId ?? source.id,
    ...(source.targetType ? { targetType: source.targetType } : {}),
    ...(source.checkoutId ? { checkoutId: source.checkoutId } : {}),
    ...(source.role ? { role: source.role } : {}),
    ...(source.actionId ? { actionId: source.actionId } : {}),
    ...(source.managed !== undefined ? { managed: source.managed } : {}),
    ...(source.parentSessionId ? { parentSessionId: source.parentSessionId } : {}),
    ...(source.planVersionId ? { planVersionId: source.planVersionId } : {}),
    ...(source.managerActionId ? { managerActionId: source.managerActionId } : {}),
  };
}

function parseIntQuery(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
