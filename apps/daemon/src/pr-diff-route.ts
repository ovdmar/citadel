import { execFileSync } from "node:child_process";
import type { SqliteStore } from "@citadel/db";
import type express from "express";
import type { ProviderCache } from "./app-helpers.js";

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

type PrDiffPayload = {
  provider: "local-git";
  truncated: boolean;
  diff: string;
  checkedAt: string;
};

export function registerPrDiffRoute(input: {
  app: express.Express;
  store: SqliteStore;
  providerCache: ProviderCache;
  asyncRoute: AsyncRoute;
}) {
  const { app, store, providerCache, asyncRoute } = input;
  app.get(
    "/api/workspaces/:workspaceId/pr-diff",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const snapshot = store.getWorkspacePrSnapshot(workspace.id);
      const headSha = readLocalHead(workspace.path) ?? snapshot?.lastHeadSha ?? null;
      const baseSha = readBaseSha(workspace.path, workspace.baseBranch);
      const cacheKey = headSha ? `pr-diff:${workspace.id}:${baseSha ?? "unknown-base"}:${headSha}` : null;
      const cached = cacheKey ? providerCache.get(cacheKey) : null;
      if (cached && cached.expiresAt > Date.now()) return res.json(cached.value);
      try {
        const stdout = readLocalPrDiff(workspace.path, workspace.baseBranch);
        const payload: PrDiffPayload = {
          provider: "local-git",
          truncated: stdout.length > 256 * 1024,
          diff: stdout.slice(0, 256 * 1024),
          checkedAt: new Date().toISOString(),
        };
        if (cacheKey) providerCache.set(cacheKey, { expiresAt: Date.now() + 60 * 60_000, value: payload });
        res.json(payload);
      } catch (error) {
        res.status(424).json({
          provider: "local-git",
          diff: "",
          truncated: false,
          error: error instanceof Error ? error.message : "git_pr_diff_failed",
          checkedAt: new Date().toISOString(),
        });
      }
    }),
  );
}

function readLocalPrDiff(workspacePath: string, baseBranch: string): string {
  const baseRef = resolveBaseRef(workspacePath, baseBranch);
  const mergeBase = execGit(workspacePath, ["merge-base", "HEAD", baseRef]);
  return execGit(workspacePath, ["diff", "--no-ext-diff", mergeBase, "HEAD", "--"]);
}

function readBaseSha(workspacePath: string, baseBranch: string): string | null {
  try {
    return execGit(workspacePath, ["rev-parse", resolveBaseRef(workspacePath, baseBranch)]);
  } catch {
    return null;
  }
}

function resolveBaseRef(workspacePath: string, baseBranch: string): string {
  const branch = baseBranch.replace(/^origin\//, "");
  const candidates = [`origin/${branch}`, baseBranch];
  for (const candidate of candidates) {
    try {
      execGit(workspacePath, ["rev-parse", "--verify", `${candidate}^{commit}`]);
      return candidate;
    } catch {
      // Try the next local ref candidate.
    }
  }
  throw new Error(`base_ref_not_found:${baseBranch}`);
}

function readLocalHead(workspacePath: string): string | null {
  try {
    return execGit(workspacePath, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

function execGit(workspacePath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspacePath,
    timeout: 12_000,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}
