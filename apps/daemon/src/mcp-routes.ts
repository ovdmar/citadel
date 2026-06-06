import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { McpToolCall } from "@citadel/mcp";
import { mcpStatus, mcpToolDefinitions, serializeWorkspaceResource } from "@citadel/mcp";
import { collectProviderHealth } from "@citadel/providers";
import type express from "express";
import { ZodError } from "zod";
import { rpcError, rpcJsonContent, rpcResourceContent, rpcResult } from "./rpc.js";

export type McpRouteContext = {
  config: CitadelConfig;
  store: SqliteStore;
  callDaemonMcpTool: (call: McpToolCall) => Promise<unknown>;
  readMcpResource: (uri: string) => Promise<unknown>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function registerMcpRoutes(
  app: express.Express,
  asyncRoute: (
    handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
  ) => express.RequestHandler,
  ctx: McpRouteContext,
) {
  const { config, store, callDaemonMcpTool, readMcpResource } = ctx;

  app.get("/api/mcp/status", (_req, res) => {
    res.json(mcpStatus(config.mcp.enabled));
  });

  app.get("/api/mcp/resources/workspaces", (_req, res) => {
    res.json(
      serializeWorkspaceResource({
        repos: store.listRepos(),
        workspaces: store.listWorkspaces(),
        sessions: store.listSessions(),
      }),
    );
  });

  app.get("/api/mcp/resources/repos", (_req, res) => {
    res.json({ repos: store.listRepos() });
  });

  app.get(
    "/api/mcp/resources/provider-health",
    asyncRoute(async (_req, res) => {
      res.json({ providerHealth: await collectProviderHealth(config.providers) });
    }),
  );

  app.get("/api/mcp/resources/activity", (_req, res) => {
    res.json({ activity: store.listActivity() });
  });

  app.get("/api/mcp/resources/namespaces", (_req, res) => {
    res.json({ namespaces: store.listNamespaces() });
  });

  app.post(
    "/api/mcp/tools/call",
    asyncRoute(async (req, res) => {
      if (!config.mcp.enabled) return res.status(503).json({ error: "mcp_disabled" });
      const call = req.body as McpToolCall;
      const result = await callDaemonMcpTool(call);
      res.json({ result });
    }),
  );

  app.post(
    "/api/mcp/rpc",
    asyncRoute(async (req, res) => {
      const request = req.body as { id?: string | number | null; method?: string; params?: Record<string, unknown> };
      const isNotification = request.id === undefined || request.id === null;
      try {
        if (!config.mcp.enabled) return res.status(503).json(rpcError(request.id, -32000, "mcp_disabled"));
        switch (request.method) {
          case "initialize":
            return res.json(
              rpcResult(request.id, {
                protocolVersion:
                  typeof request.params?.protocolVersion === "string" && request.params.protocolVersion === "2024-11-05"
                    ? request.params.protocolVersion
                    : "2024-11-05",
                serverInfo: { name: "citadel", version: "0.2.0" },
                capabilities: { resources: {}, tools: {} },
              }),
            );
          case "notifications/initialized":
            return res.status(202).end();
          case "ping":
            return res.json(rpcResult(request.id, {}));
          case "tools/list":
            return res.json(rpcResult(request.id, { tools: mcpToolDefinitions() }));
          case "tools/call": {
            const params = request.params as McpToolCall;
            const result = await callDaemonMcpTool(params);
            return res.json(rpcResult(request.id, rpcJsonContent(result)));
          }
          case "resources/list":
            return res.json(
              rpcResult(request.id, {
                resources: mcpStatus(config.mcp.enabled).resources.map((uri) => ({
                  uri,
                  name: uri.replace("citadel://", ""),
                })),
              }),
            );
          case "resources/read": {
            const uri = typeof request.params?.uri === "string" ? request.params.uri : "";
            const resource = await readMcpResource(uri);
            if (!resource) return res.json(rpcError(request.id, -32602, "unknown_resource"));
            return res.json(rpcResult(request.id, { contents: [rpcResourceContent(uri, resource)] }));
          }
          default:
            if (isNotification) return res.status(202).end();
            return res.json(rpcError(request.id, -32601, "method_not_found"));
        }
      } catch (error) {
        if (isNotification) return res.status(202).end();
        if (error instanceof ZodError) {
          return res.status(400).json({
            error: "validation_failed",
            issues: error.issues.map((issue) => ({ ...issue, path: issue.path.join(".") })),
          });
        }
        return res.json(rpcError(request.id, -32000, errorMessage(error)));
      }
    }),
  );
}
