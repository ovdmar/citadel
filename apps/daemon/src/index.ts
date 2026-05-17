import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import {
  type AppEvent,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateWorkspaceInputSchema,
  type DiffFile,
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
const operations = new OperationService(store, config);
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

function readWorkspaceDiff(workspaceId: string, cwd: string) {
  const maxBytes = 128 * 1024;
  const status = execGit(cwd, ["status", "--porcelain=v1", "-z"]);
  const paths = parseStatus(status);
  const files: DiffFile[] = paths.slice(0, 80).map((entry) => {
    const diff =
      entry.status === "??"
        ? readUntrackedFilePreview(cwd, entry.path, maxBytes)
        : execGit(cwd, ["diff", "--no-ext-diff", "HEAD", "--", entry.path]);
    const binary = diff.includes("Binary files") || diff.includes("GIT binary patch");
    const truncated = diff.length > maxBytes;
    return {
      path: entry.path,
      status: entry.status,
      binary,
      truncated,
      diff: binary ? "" : diff.slice(0, maxBytes),
    };
  });
  return {
    workspaceId,
    clean: paths.length === 0,
    files,
    truncated: paths.length > files.length || files.some((file) => file.truncated),
  };
}

function readUntrackedFilePreview(cwd: string, relativePath: string, maxBytes: number) {
  const absolutePath = path.resolve(cwd, relativePath);
  if (!absolutePath.startsWith(path.resolve(cwd))) throw new Error("invalid_diff_path");
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) return "";
  const content = fs.readFileSync(absolutePath);
  const preview = content.subarray(0, maxBytes).toString("utf8");
  return `--- /dev/null\n+++ b/${relativePath}\n@@ untracked preview @@\n${preview}`;
}

function execGit(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 });
}

function parseStatus(input: string) {
  const parts = input.split("\0").filter(Boolean);
  const entries: { status: string; path: string }[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const item = parts[index];
    if (!item) continue;
    const status = item.slice(0, 2);
    const filePath = item.slice(3);
    if (status.startsWith("R") || status.startsWith("C")) index += 1;
    entries.push({ status, path: filePath });
  }
  return entries;
}

server.listen(config.port, config.bindHost, () => {
  console.log(`Citadel daemon listening on http://${config.bindHost}:${config.port}`);
});
