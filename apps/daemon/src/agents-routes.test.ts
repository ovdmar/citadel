import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { RuntimeModelLister } from "@citadel/runtimes";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDefinitionsStorage, createAgentDefinitionsStorage } from "./agent-definitions/storage.js";
import { registerAgentsRoutes } from "./agents-routes.js";

type HttpResult = { status: number; body: Record<string, unknown> };

async function request(server: http.Server, method: string, p: string, body?: unknown): Promise<HttpResult> {
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("server not listening");
  const port = (address as { port: number }).port;
  return new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: p,
        headers: { "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const parsed = raw.length === 0 ? {} : JSON.parse(raw);
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function mountApp(opts: {
  storage: AgentDefinitionsStorage;
  modelListers?: Record<string, RuntimeModelLister>;
  runtimes?: Array<{ id: string; command: string; args: string[] }>;
  now?: () => number;
}): { app: express.Express; close: () => Promise<void>; server: http.Server } {
  const app = express();
  app.use(express.json());
  const asyncRoute =
    (
      handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>,
    ): express.RequestHandler =>
    (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };
  registerAgentsRoutes({
    app,
    asyncRoute,
    agentDefinitions: opts.storage,
    runtimes: () => opts.runtimes ?? [{ id: "claude-code", command: "claude", args: [] }],
    modelListers: opts.modelListers,
    now: opts.now,
  });
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  });
  const server = http.createServer(app);
  return new Promise<{ app: express.Express; close: () => Promise<void>; server: http.Server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        app,
        server,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  }) as never;
}

async function mountAppAsync(opts: Parameters<typeof mountApp>[0]) {
  return (await mountApp(opts)) as unknown as { app: express.Express; close: () => Promise<void>; server: http.Server };
}

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dirs.length = 0;
  closers.length = 0;
});

afterEach(async () => {
  for (const close of closers) {
    try {
      await close();
    } catch {
      // ignore
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeStorage() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-routes-"));
  const configPath = path.join(baseDir, "..", `${path.basename(baseDir)}.config.json`);
  dirs.push(baseDir);
  return createAgentDefinitionsStorage({ baseDir, configPath });
}

function makeBrokenStorage() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-routes-broken-"));
  dirs.push(parent);
  const blocker = path.join(parent, "block");
  fs.writeFileSync(blocker, "");
  return createAgentDefinitionsStorage({
    baseDir: path.join(blocker, "agents"),
    configPath: path.join(blocker, "agents.config.json"),
  });
}

async function mount(opts: Parameters<typeof mountApp>[0]) {
  const ctx = await mountAppAsync(opts);
  closers.push(ctx.close);
  return ctx;
}

describe("agents routes", () => {
  it("GET /api/agents returns predefined definitions + config", async () => {
    const { server } = await mount({ storage: makeStorage() });
    const res = await request(server, "GET", "/api/agents");
    expect(res.status).toBe(200);
    const definitions = (res.body.definitions as Array<{ id: string }>).map((d) => d.id);
    expect(definitions).toContain("implementation");
    expect(definitions).toContain("architect");
    expect((res.body.config as { defaultRuntime: string }).defaultRuntime).toBe("claude-code");
  });

  it("DELETE on a predefined agent returns 409 predefined_agent_cannot_be_deleted", async () => {
    const { server } = await mount({ storage: makeStorage() });
    await request(server, "GET", "/api/agents");
    const res = await request(server, "DELETE", "/api/agents/implementation");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("predefined_agent_cannot_be_deleted");
  });

  it("POST creates custom, PATCH updates, DELETE removes", async () => {
    const { server } = await mount({ storage: makeStorage() });
    await request(server, "GET", "/api/agents");
    const create = await request(server, "POST", "/api/agents", {
      name: "Reviewer",
      systemPrompt: "Review.",
      runtime: "claude-code",
    });
    expect(create.status).toBe(201);
    const id = (create.body.definition as { id: string }).id;
    const update = await request(server, "PATCH", `/api/agents/${id}`, { systemPrompt: "Review hard." });
    expect((update.body.definition as { systemPrompt: string }).systemPrompt).toBe("Review hard.");
    const remove = await request(server, "DELETE", `/api/agents/${id}`);
    expect(remove.status).toBe(204);
  });

  it("POST /api/agents/:id/reset on a custom id returns 400", async () => {
    const { server } = await mount({ storage: makeStorage() });
    await request(server, "GET", "/api/agents");
    const create = await request(server, "POST", "/api/agents", {
      name: "Reviewer",
      systemPrompt: "x",
      runtime: "claude-code",
    });
    const id = (create.body.definition as { id: string }).id;
    const reset = await request(server, "POST", `/api/agents/${id}/reset`);
    expect(reset.status).toBe(400);
  });

  it("GET /api/runtimes/:id/models honors the 1h TTL and ?refresh=1 bypasses it", async () => {
    let counter = 0;
    const lister: RuntimeModelLister = async () => {
      counter += 1;
      return { models: [{ id: "claude-sonnet-4-6", isDefault: true }] };
    };
    let nowMs = 1_000_000;
    const { server } = await mount({
      storage: makeStorage(),
      modelListers: { "claude-code": lister },
      now: () => nowMs,
    });
    const a = await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(a.status).toBe(200);
    expect(counter).toBe(1);
    await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(counter).toBe(1);
    nowMs += 30 * 60 * 1_000;
    await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(counter).toBe(1);
    nowMs += 31 * 60 * 1_000;
    await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(counter).toBe(2);
    await request(server, "GET", "/api/runtimes/claude-code/models?refresh=1");
    expect(counter).toBe(3);
  });

  it("model probe error propagates as probeError on the response", async () => {
    const lister: RuntimeModelLister = async () => {
      throw new Error("tmux exploded");
    };
    const { server } = await mount({
      storage: makeStorage(),
      modelListers: { "claude-code": lister },
    });
    const res = await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(res.status).toBe(200);
    expect(res.body.probeError).toBe("tmux exploded");
  });

  it("model probe with probeError in the result propagates without throwing", async () => {
    const lister: RuntimeModelLister = async () => ({
      models: [{ id: "fallback", isDefault: true }],
      probeError: "no_models_parsed",
    });
    const { server } = await mount({
      storage: makeStorage(),
      modelListers: { "claude-code": lister },
    });
    const res = await request(server, "GET", "/api/runtimes/claude-code/models");
    expect(res.body.probeError).toBe("no_models_parsed");
    expect((res.body.models as Array<{ id: string }>).map((m) => m.id)).toEqual(["fallback"]);
  });

  it("GET /api/agents returns 503 when storage is unavailable", async () => {
    const { server } = await mount({ storage: makeBrokenStorage() });
    const res = await request(server, "GET", "/api/agents");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("agent_storage_unavailable");
  });

  it("PUT /api/agents/config persists defaultRuntime", async () => {
    const storage = makeStorage();
    const { server } = await mount({ storage });
    const res = await request(server, "PUT", "/api/agents/config", { defaultRuntime: "codex" });
    expect((res.body.config as { defaultRuntime: string }).defaultRuntime).toBe("codex");
    expect(storage.readConfig().defaultRuntime).toBe("codex");
  });
});
