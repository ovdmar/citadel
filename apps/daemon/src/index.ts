import http from "node:http";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import {
  type AppEvent,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateWorkspaceInputSchema,
} from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { mcpStatus, serializeWorkspaceResource } from "@citadel/mcp";
import { OperationService } from "@citadel/operations";
import { collectProviderHealth } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import { attachTerminalWebSocket } from "@citadel/terminal";
import cors from "cors";
import express from "express";

const config = loadConfig();
const store = new SqliteStore(config.databasePath);
store.migrate();
const operations = new OperationService(store);
const app = express();
const server = http.createServer(app);
const sseClients = new Set<express.Response>();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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

app.post("/api/repos", (req, res) => {
  const input = CreateRepoInputSchema.parse(req.body);
  const repo = operations.registerRepo(input);
  emit("repo.updated", { repoId: repo.id, repo });
  res.status(201).json({ repo });
});

app.get("/api/repos", (_req, res) => {
  res.json({ repos: store.listRepos() });
});

app.get("/api/workspaces", (_req, res) => {
  res.json({ workspaces: store.listWorkspaces() });
});

app.post("/api/workspaces", (req, res) => {
  const input = CreateWorkspaceInputSchema.parse(req.body);
  const result = operations.createWorkspace(input);
  emit("workspace.updated", result);
  res.status(202).json(result);
});

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

app.get("/api/diff/:workspaceId", (req, res) => {
  const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
  if (!path.resolve(workspace.path).startsWith(path.resolve(workspace.path)))
    return res.status(400).json({ error: "invalid_path" });
  res.json({
    workspaceId: workspace.id,
    note: "Read-only diff endpoint placeholder; full bounded git diff viewer is tracked in MS-482.",
  });
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
  const message = error instanceof Error ? error.message : "request_failed";
  res.status(400).json({ error: message });
});

attachTerminalWebSocket(server, (sessionId) => {
  const session = store.listSessions().find((candidate) => candidate.id === sessionId);
  return session?.tmuxSessionName ?? null;
});

function emit(type: string, payload: unknown) {
  const event: AppEvent = {
    id: `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    timestamp: new Date().toISOString(),
    source: "daemon",
    payload,
  };
  for (const client of sseClients) client.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function asyncRoute(
  handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

server.listen(config.port, config.bindHost, () => {
  console.log(`Citadel daemon listening on http://${config.bindHost}:${config.port}`);
});
