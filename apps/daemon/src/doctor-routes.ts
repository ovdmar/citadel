import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { CitadelConfig } from "@citadel/config";
import type { Repo } from "@citadel/contracts";
import type { DoctorReport } from "@citadel/contracts/doctor";
import type { SqliteStore } from "@citadel/db";
import { CURRENT_SCHEMA_VERSION } from "@citadel/db";
import { DEPLOY_HOOK_RELATIVE_PATH } from "@citadel/hooks";
import {
  type DeployHookStatus,
  type DoctorConfig,
  type DoctorDeps,
  type DoctorProviderProbe,
  type DoctorProviderStatus,
  type DoctorRepo,
  runDoctorChecks,
} from "@citadel/operations";
import type express from "express";

const execFile = promisify(execFileCb);

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

// Resolve the executability of <workspacePath>/.citadel/hooks/deploy using
// the same convention as packages/hooks. Returning a DeployHookStatus keeps
// the operations doctor independent of any node:fs.
function inspectDeployHookFile(workspacePath: string): DeployHookStatus {
  const filePath = path.join(workspacePath, DEPLOY_HOOK_RELATIVE_PATH);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return "missing";
    try {
      fs.accessSync(filePath, fs.constants.X_OK);
      return "executable";
    } catch {
      return "exists-not-executable";
    }
  } catch {
    return "missing";
  }
}

function toDoctorConfig(config: CitadelConfig): DoctorConfig {
  return {
    bindHost: config.bindHost,
    port: config.port,
    providers: config.providers,
    tls: config.tls,
  };
}

function toDoctorRepo(repo: Repo): DoctorRepo {
  return {
    id: repo.id,
    name: repo.name,
    rootPath: repo.rootPath,
    setupHookIds: [...repo.setupHookIds],
    teardownHookIds: [...repo.teardownHookIds],
    deployHookCommand: repo.deployHookCommand,
  };
}

// Map daemon-side ProviderHealth.status to the doctor's local DoctorProviderStatus.
function toDoctorProviderStatus(status: string): DoctorProviderStatus {
  if (status === "healthy" || status === "degraded" || status === "unavailable") return status;
  return "unknown";
}

// Default deps used by the daemon route. Tests override individual fields.
export function defaultDoctorDeps(input: {
  store: SqliteStore;
  collectProviderHealth: () => Promise<Array<{ id: string; status: string }>>;
}): DoctorDeps {
  return {
    which: async (bin) => {
      try {
        const { stdout } = await execFile("command", ["-v", bin], { timeout: 2000, shell: "/bin/bash" });
        const out = stdout.trim();
        return out.length > 0 ? out : null;
      } catch {
        return null;
      }
    },
    fetchHealth: async (url) => {
      // The daemon's own route doesn't probe itself, but cli path uses node fetch.
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    readDbSchemaVersion: async () => {
      // The daemon's running DB owns the answer — read via SqliteStore.
      try {
        const rows = input.store.listSchemaMigrations?.() ?? null;
        if (!rows || rows.length === 0) return null;
        return Math.max(...rows.map((r) => r.version));
      } catch {
        return null;
      }
    },
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    listRepos: () => input.store.listRepos().map(toDoctorRepo),
    inspectDeployHook: inspectDeployHookFile,
    listSystemdServices: async () => {
      // Daemon mode — skip.
      return { available: false, citadel: "skipped", tmux: "skipped" };
    },
    collectProviderHealth: async (): Promise<DoctorProviderProbe[]> => {
      const rows = await input.collectProviderHealth();
      return rows.map((row) => ({ provider: row.id, status: toDoctorProviderStatus(row.status) }));
    },
    fsStat: (filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { exists: true, size: stat.size };
      } catch {
        return { exists: false, size: 0 };
      }
    },
    retries: 1,
    retryDelayMs: 0,
  };
}

export function registerDoctorRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  store: SqliteStore;
  asyncRoute: AsyncRoute;
  collectProviderHealth: () => Promise<Array<{ id: string; status: string }>>;
  deps?: Partial<DoctorDeps>;
}) {
  const { app, config, store, asyncRoute, collectProviderHealth, deps: overrideDeps } = input;
  const baseDeps = defaultDoctorDeps({ store, collectProviderHealth });
  const deps: DoctorDeps = { ...baseDeps, ...overrideDeps };

  app.get(
    "/api/doctor",
    asyncRoute(async (_req, res) => {
      const report: DoctorReport = await runDoctorChecks({
        config: toDoctorConfig(config),
        mode: "daemon",
        deps,
      });
      res.json(report);
    }),
  );
}
