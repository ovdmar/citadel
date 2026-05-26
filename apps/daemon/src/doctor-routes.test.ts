import type { DoctorReport } from "@citadel/contracts/doctor";
import { DoctorReportSchema } from "@citadel/contracts/doctor";
import express from "express";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { asyncRoute } from "./app-helpers.js";
import { defaultDoctorDeps, registerDoctorRoutes } from "./doctor-routes.js";

type Server = { close: () => void; port: number };

async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve({ close: () => server.close(), port: address.port });
      }
    });
  });
}

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1 as const,
    dataDir: "/tmp/citadel",
    databasePath: "/tmp/citadel/citadel.sqlite",
    bindHost: "127.0.0.1",
    port: 4010,
    mcp: { enabled: true },
    providers: {
      github: { enabled: true, command: "gh" },
      jira: { enabled: true, command: "jtk" },
    },
    runtimes: [],
    usageProviders: [],
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] },
    commandPolicy: { hookTimeoutMs: 120000, allowDestructiveWorkspaceCleanup: false },
    scratchpad: { path: "/tmp/citadel/scratchpad.md" },
    ...overrides,
  } as unknown as Parameters<typeof registerDoctorRoutes>[0]["config"];
}

function fakeStore() {
  return {
    listRepos: () => [],
    listSchemaMigrations: () => [{ version: 8, name: "test", appliedAt: new Date().toISOString() }],
  } as unknown as Parameters<typeof registerDoctorRoutes>[0]["store"];
}

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function bootApp(overrides: Partial<Parameters<typeof registerDoctorRoutes>[0]> = {}) {
  const app = express();
  app.use(express.json());
  const config = overrides.config ?? fakeConfig();
  const store = overrides.store ?? fakeStore();
  const collectProviderHealth =
    overrides.collectProviderHealth ?? (async () => [{ id: "github", status: "healthy" } as const]);
  registerDoctorRoutes({
    app,
    config,
    store,
    asyncRoute,
    collectProviderHealth,
    deps: { ...overrides.deps, retries: 1, retryDelayMs: 0 },
  });
  const server = await listen(app);
  servers.push(server);
  return server;
}

async function fetchJson(port: number, pathname: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
  return res.json();
}

describe("GET /api/doctor", () => {
  it("returns 200 with a DoctorReport-shaped body", async () => {
    const server = await bootApp();
    const body = (await fetchJson(server.port, "/api/doctor")) as DoctorReport;
    expect(() => DoctorReportSchema.parse(body)).not.toThrow();
    expect(body.version).toBe(1);
  });

  it("report.protocol === 'https' when config.tls is set", async () => {
    const server = await bootApp({
      config: fakeConfig({
        tls: { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" },
      }),
    });
    const body = (await fetchJson(server.port, "/api/doctor")) as DoctorReport;
    expect(body.protocol).toBe("https");
  });

  it("includes one repo-hooks check per registered repo", async () => {
    const repos = [
      {
        id: "r1",
        name: "first",
        rootPath: "/tmp/r1",
        setupHookIds: ["x"],
        teardownHookIds: [],
        deployHookCommand: null,
      },
      {
        id: "r2",
        name: "second",
        rootPath: "/tmp/r2",
        setupHookIds: [],
        teardownHookIds: [],
        deployHookCommand: null,
      },
    ];
    const server = await bootApp({
      store: {
        listRepos: () => repos,
        listSchemaMigrations: () => [{ version: 8, name: "test", appliedAt: new Date().toISOString() }],
      } as unknown as Parameters<typeof registerDoctorRoutes>[0]["store"],
    });
    const body = (await fetchJson(server.port, "/api/doctor")) as DoctorReport;
    const repoHookChecks = body.checks.filter((c) => c.kind === "repo-hooks");
    expect(repoHookChecks.length).toBe(2);
    expect(repoHookChecks.map((c) => c.id).sort()).toEqual(["repo-hooks.r1", "repo-hooks.r2"]);
  });

  it("daemon mode skips required-binary checks", async () => {
    const server = await bootApp();
    const body = (await fetchJson(server.port, "/api/doctor")) as DoctorReport;
    const binaries = body.checks.filter((c) => c.kind === "binary");
    expect(binaries.length).toBeGreaterThan(0);
    expect(binaries.every((c) => c.status === "skipped")).toBe(true);
  });
});

describe("defaultDoctorDeps", () => {
  it("composes all required fields", () => {
    const deps = defaultDoctorDeps({
      store: {
        listRepos: () => [],
        listSchemaMigrations: () => [],
      } as unknown as Parameters<typeof defaultDoctorDeps>[0]["store"],
      collectProviderHealth: async () => [],
    });
    expect(typeof deps.which).toBe("function");
    expect(typeof deps.fetchHealth).toBe("function");
    expect(deps.expectedSchemaVersion).toBeGreaterThan(0);
  });
});
