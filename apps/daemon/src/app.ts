import http from "node:http";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { mergeConfigPatch, saveConfig } from "@citadel/config";
import {
  type AppEvent,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateWorkspaceInputSchema,
  TransitionIssueInputSchema,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type McpToolCall, callMcpTool, mcpStatus, mcpToolDefinitions, serializeWorkspaceResource } from "@citadel/mcp";
import { OperationService } from "@citadel/operations";
import {
  collectGitHubCiRunLog,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectJiraIssueSummary,
  collectProviderHealth,
  transitionJiraIssue,
} from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import { attachTerminalWebSocket } from "@citadel/terminal";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { readWorkspaceDiff } from "./workspace-diff.js";

export type DaemonApp = {
  app: express.Express;
  server: http.Server;
  emit: (type: string, payload: unknown) => void;
};

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectGitHubCiRunLog: typeof collectGitHubCiRunLog;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
  transitionJiraIssue: typeof transitionJiraIssue;
};

export function createDaemonApp(input: {
  config: CitadelConfig;
  configPath: string;
  store: SqliteStore;
  operations?: OperationService;
  providers?: Partial<ProviderCollectors>;
}): DaemonApp {
  const { config, configPath, store } = input;
  const operations = input.operations ?? new OperationService(store, config);
  const providers: ProviderCollectors = {
    collectGitHubVersionControlSummary,
    collectGitHubCiRuns,
    collectGitHubCiRunLog,
    collectJiraIssueSummary,
    transitionJiraIssue,
    ...input.providers,
  };
  const app = express();
  const server = http.createServer(app);
  const sseClients = new Set<express.Response>();
  const providerCache = new Map<string, { expiresAt: number; value: unknown }>();

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  const emit = (type: string, payload: unknown) => {
    const event: AppEvent = {
      id: `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      source: "daemon",
      payload,
    };
    for (const client of sseClients) client.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  };

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const providerHealth = await collectProviderHealth(config.providers);
      const degradedProviders = providerHealth.filter((provider) => provider.status !== "healthy");
      res.json({
        ok: true,
        app: "citadel",
        mode: "local-first",
        databasePath: config.databasePath,
        degradedProviders: degradedProviders.length,
        providerHealth,
        mcp: mcpStatus(config.mcp.enabled),
        now: new Date().toISOString(),
      });
    }),
  );

  app.get(
    "/api/state",
    asyncRoute(async (_req, res) => {
      const repos = store.listRepos();
      const workspaces = store.listWorkspaces();
      const sessions = store.listSessions();
      const providerHealth = await collectProviderHealth(config.providers);
      res.json({
        repos,
        workspaces,
        sessions,
        operations: store.listOperations(),
        activity: store.listActivity(),
        providerHealth,
        runtimes: listRuntimeHealth(config.runtimes),
        mcp: mcpStatus(config.mcp.enabled),
      });
    }),
  );

  app.get("/api/config", (_req, res) => {
    res.json({ config, configPath });
  });

  app.put("/api/config", (req, res) => {
    const nextConfig = mergeConfigPatch(config, req.body);
    const saved = saveConfig(nextConfig, configPath);
    Object.assign(config, saved);
    providerCache.clear();
    store.addActivity({
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      type: "settings.updated",
      source: "user",
      repoId: null,
      workspaceId: null,
      operationId: null,
      message: "Updated local config",
      createdAt: new Date().toISOString(),
    });
    emit("config.updated", { configPath });
    res.json({ config, configPath });
  });

  app.post("/api/repos", (req, res) => {
    const input = CreateRepoInputSchema.parse(req.body);
    const repo = operations.registerRepo(input);
    emit("repo.updated", { repoId: repo.id, repo });
    res.status(201).json({ repo });
  });

  app.get("/api/repos", (_req, res) => {
    res.json({ repos: store.listRepos() });
  });

  app.get(
    "/api/repos/:repoId/provider-summary",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const versionControl = await cachedProvider(`vc:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubVersionControlSummary(repo.rootPath),
      );
      res.json({ versionControl });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const ci = await cachedProvider(`ci:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubCiRuns(repo.rootPath),
      );
      res.json({ ci });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs/:runId/logs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      const runId = req.params.runId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      if (typeof runId !== "string") return res.status(400).json({ error: "run_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const log = await providers.collectGitHubCiRunLog(repo.rootPath, runId);
      res.json({ log });
    }),
  );

  app.get("/api/workspaces", (_req, res) => {
    res.json({ workspaces: store.listWorkspaces() });
  });

  app.get(
    "/api/workspaces/:workspaceId/issue-summary",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const issueTracker = await cachedProvider(`issue:${workspace.issueKey}`, () =>
        providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
      );
      res.json({ issueTracker });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/issue-transition",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const input = TransitionIssueInputSchema.parse(req.body);
      const result = await providers.transitionJiraIssue({
        issueKey: workspace.issueKey,
        transition: input.transition,
        fields: input.fields,
      });
      providerCache.delete(`issue:${workspace.issueKey}`);
      emit("provider.issue_transition", { workspaceId: workspace.id, issueKey: workspace.issueKey, result });
      res.status(result.status === "healthy" ? 202 : 424).json({ result });
    }),
  );

  app.post(
    "/api/workspaces",
    asyncRoute(async (req, res) => {
      const input = CreateWorkspaceInputSchema.parse(req.body);
      const result = await operations.createWorkspace(input);
      emit("workspace.updated", result);
      res.status(202).json(result);
    }),
  );

  app.get("/api/runtimes", (_req, res) => {
    res.json({ runtimes: listRuntimeHealth(config.runtimes) });
  });

  app.post(
    "/api/agent-sessions",
    asyncRoute(async (req, res) => {
      const input = CreateAgentSessionInputSchema.parse(req.body);
      const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });
      const session = await operations.createAgentSession(input, runtime);
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session });
    }),
  );

  app.get("/api/activity", (req, res) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined;
    res.json({ activity: store.listActivity(workspaceId) });
  });

  app.delete(
    "/api/workspaces/:workspaceId",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const result = await operations.removeWorkspace({
        workspaceId,
        force: req.query.force === "true",
        archiveOnly: req.query.archiveOnly === "true",
      });
      emit("workspace.updated", result);
      res.status(result.removed || result.archived ? 202 : 409).json(result);
    }),
  );

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
      if (!config.mcp.enabled) return res.status(503).json(rpcError(request.id, -32000, "mcp_disabled"));
      switch (request.method) {
        case "initialize":
          return res.json(
            rpcResult(request.id, {
              protocolVersion: "2024-11-05",
              serverInfo: { name: "citadel", version: "0.2.0" },
              capabilities: { resources: {}, tools: {} },
            }),
          );
        case "tools/list":
          return res.json(rpcResult(request.id, { tools: mcpToolDefinitions() }));
        case "tools/call": {
          const params = request.params as McpToolCall;
          const result = await callDaemonMcpTool(params);
          return res.json(rpcResult(request.id, { content: [{ type: "json", json: result }] }));
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
          if (uri !== "citadel://workspaces") return res.json(rpcError(request.id, -32602, "unknown_resource"));
          return res.json(
            rpcResult(request.id, { contents: [{ uri, mimeType: "application/json", json: workspaceResource() }] }),
          );
        }
        default:
          return res.json(rpcError(request.id, -32601, "method_not_found"));
      }
    }),
  );

  app.get("/api/workspaces/:workspaceId/diff", (req, res) => {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
    if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
    if (!path.resolve(workspace.path).startsWith(path.resolve(workspace.path)))
      return res.status(400).json({ error: "invalid_path" });
    res.json(readWorkspaceDiff(workspace.id, workspace.path));
  });

  app.get("/events", (req, res) => {
    req.socket.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseClients.add(res);
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    req.on("close", () => sseClients.delete(res));
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: "validation_failed",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const message = error instanceof Error ? error.message : "request_failed";
    res.status(400).json({ error: message });
  });

  attachTerminalWebSocket(server, (sessionId) => {
    const session = store.listSessions().find((candidate) => candidate.id === sessionId);
    return session?.tmuxSessionName ?? null;
  });

  return { app, server, emit };

  async function callDaemonMcpTool(call: McpToolCall) {
    if (call.name === "create_workspace") {
      const result = await operations.createWorkspace(CreateWorkspaceInputSchema.parse(call.arguments ?? {}));
      emit("workspace.updated", result);
      return result;
    }
    if (call.name === "start_agent_session") {
      const input = CreateAgentSessionInputSchema.parse(call.arguments ?? {});
      const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
      if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
      const session = await operations.createAgentSession(input, runtime);
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      return { session };
    }
    if (call.name === "archive_workspace") {
      const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
      const result = await operations.removeWorkspace({ workspaceId, archiveOnly: true });
      emit("workspace.updated", result);
      return result;
    }
    const providerHealth = await collectProviderHealth(config.providers);
    return callMcpTool(call, {
      repos: store.listRepos(),
      workspaces: store.listWorkspaces(),
      sessions: store.listSessions(),
      operations: store.listOperations(),
      providerHealth,
      runtimes: listRuntimeHealth(config.runtimes),
    });
  }

  function workspaceResource() {
    return serializeWorkspaceResource({
      repos: store.listRepos(),
      workspaces: store.listWorkspaces(),
      sessions: store.listSessions(),
    });
  }

  async function cachedProvider<T>(key: string, load: () => Promise<T>, ttlMs = 10_000) {
    const cached = providerCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value as T;
    const value = await load();
    providerCache.set(key, { expiresAt: now + ttlMs, value });
    return value;
  }
}

function rpcResult(id: string | number | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}
