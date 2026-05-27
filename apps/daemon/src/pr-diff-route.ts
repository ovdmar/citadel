import { execFileSync } from "node:child_process";
import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type express from "express";
import type { ProviderCache } from "./app-helpers.js";

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

type PrDiffPayload = {
  provider: "github-gh";
  truncated: boolean;
  diff: string;
  checkedAt: string;
};

export function registerPrDiffRoute(input: {
  app: express.Express;
  store: SqliteStore;
  config: CitadelConfig;
  providerCache: ProviderCache;
  asyncRoute: AsyncRoute;
}) {
  const { app, store, config, providerCache, asyncRoute } = input;
  app.get(
    "/api/workspaces/:workspaceId/pr-diff",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const snapshot = store.getWorkspacePrSnapshot(workspace.id);
      const headSha = readLocalHead(workspace.path) ?? snapshot?.lastHeadSha ?? null;
      const cacheKey = headSha ? `pr-diff:${workspace.id}:${headSha}` : null;
      const cached = cacheKey ? providerCache.get(cacheKey) : null;
      if (cached && cached.expiresAt > Date.now()) return res.json(cached.value);
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFileCb);
        const { stdout } = await exec(config.providers.github.command ?? "gh", ["pr", "diff"], {
          cwd: workspace.path,
          timeout: 12_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const payload: PrDiffPayload = {
          provider: "github-gh",
          truncated: stdout.length > 256 * 1024,
          diff: stdout.slice(0, 256 * 1024),
          checkedAt: new Date().toISOString(),
        };
        if (cacheKey) providerCache.set(cacheKey, { expiresAt: Date.now() + 60 * 60_000, value: payload });
        res.json(payload);
      } catch (error) {
        res.status(424).json({
          provider: "github-gh",
          diff: "",
          truncated: false,
          error: error instanceof Error ? error.message : "gh_pr_diff_failed",
          checkedAt: new Date().toISOString(),
        });
      }
    }),
  );
}

function readLocalHead(workspacePath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
