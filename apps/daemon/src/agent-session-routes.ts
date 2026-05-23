import type { OperationService } from "@citadel/operations";
import type express from "express";

type AsyncRoute = (
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) => express.RequestHandler;

type Deps = {
  operations: OperationService;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: AsyncRoute;
};

/**
 * Read-side and message-side routes for individual agent sessions. The
 * REST surface mirrors the MCP tools so the cockpit UI and external
 * automation share the same backend code path.
 */
export function registerAgentSessionRoutes(app: express.Express, deps: Deps) {
  const { operations, emit, asyncRoute } = deps;

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

function parseIntQuery(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
