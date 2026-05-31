import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { CreateRepoInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import type express from "express";
import { bustCacheByPrefixes } from "./workspace-fs-watcher.js";

type Emit = (type: string, payload: unknown) => void;
type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

function expandTilde(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function registerRepoRoutes(input: {
  app: express.Express;
  asyncRoute: AsyncRoute;
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  emit: Emit;
}) {
  const { app, asyncRoute, config, store, operations, providerCache, emit } = input;

  app.post("/api/repos", (req, res) => {
    const parsed = CreateRepoInputSchema.parse(req.body);
    const repo = operations.registerRepo(parsed);
    emit("repo.updated", { repoId: repo.id, repo });
    res.status(201).json({ repo });
  });

  app.post(
    "/api/repos/inspect",
    asyncRoute(async (req, res) => {
      const inputPath = typeof req.body?.rootPath === "string" ? req.body.rootPath : "";
      if (!inputPath) return res.status(400).json({ error: "root_path_required" });
      const resolved = path.resolve(expandTilde(inputPath));
      const exists = fs.existsSync(resolved);
      const isGit = exists && fs.existsSync(path.join(resolved, ".git"));
      let defaultBranch: string | null = null;
      let remotes: string[] = [];
      if (isGit) {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const exec = promisify(execFileCb);
          const headRef = await exec("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
            cwd: resolved,
            timeout: 6000,
          }).catch(() => ({ stdout: "" }));
          defaultBranch = (headRef.stdout || "").trim().replace("refs/remotes/origin/", "").trim() || "main";
          const remoteList = await exec("git", ["remote"], { cwd: resolved, timeout: 6000 }).catch(() => ({
            stdout: "",
          }));
          remotes = remoteList.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        } catch {
          defaultBranch = "main";
        }
      }
      res.json({
        rootPath: resolved,
        exists,
        isGit,
        defaultBranch,
        remotes,
        suggestedWorktreeParent: path.join(path.dirname(resolved), `${path.basename(resolved)}-worktrees`),
        providerCandidates: [
          { id: "github-gh", displayName: "GitHub CLI", enabled: config.providers.github.enabled },
          { id: "jira-jtk", displayName: "Jira CLI", enabled: config.providers.jira.enabled },
        ],
      });
    }),
  );

  app.get("/api/fs/complete", (req, res) => {
    const raw = typeof req.query.prefix === "string" ? req.query.prefix : "";
    const seed = raw || "~/";
    const trailingSlash = seed.endsWith("/");
    const expanded = expandTilde(seed);
    const baseDir = trailingSlash ? path.resolve(expanded || os.homedir()) : path.resolve(path.dirname(expanded));
    const filter = trailingSlash ? "" : path.basename(expanded);
    let entries: Array<{ name: string; path: string; isGit: boolean }> = [];
    try {
      const filterLower = filter.toLowerCase();
      const showHidden = filter.startsWith(".");
      const dirents = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const dirent of dirents) {
        if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
        if (!showHidden && dirent.name.startsWith(".")) continue;
        if (filterLower && !dirent.name.toLowerCase().startsWith(filterLower)) continue;
        const full = path.join(baseDir, dirent.name);
        if (dirent.isSymbolicLink()) {
          try {
            if (!fs.statSync(full).isDirectory()) continue;
          } catch {
            continue;
          }
        }
        const isGit = fs.existsSync(path.join(full, ".git"));
        entries.push({ name: dirent.name, path: full, isGit });
        if (entries.length >= 100) break;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      entries = entries.slice(0, 50);
    } catch {
      entries = [];
    }
    res.json({ baseDir, filter, entries });
  });

  app.get("/api/repos", (_req, res) => {
    res.json({ repos: store.listRepos() });
  });

  app.delete(
    "/api/repos/:repoId",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const result = await operations.removeRepo({
        repoId,
        force: req.query.force === "true",
        cleanupWorktrees: req.query.cleanupWorktrees === "true",
      });
      providerCache.clear();
      emit("repo.updated", result);
      res.status(result.removed ? 202 : 409).json(result);
    }),
  );

  app.get(
    "/api/repos/:repoId/branches",
    asyncRoute(async (req, res) => {
      const repo = store.listRepos().find((candidate) => candidate.id === req.params.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFileCb);
        const local = await exec("git", ["branch", "--list", "--format=%(refname:short)"], {
          cwd: repo.rootPath,
          timeout: 6000,
        });
        const remote = await exec("git", ["branch", "--remotes", "--list", "--format=%(refname:short)"], {
          cwd: repo.rootPath,
          timeout: 6000,
        });
        const localBranches = local.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const remoteBranches = remote.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !line.endsWith("/HEAD"))
          .map((line) => (line.includes("/") ? line.split("/").slice(1).join("/") : line));
        return res.json({
          defaultBranch: repo.defaultBranch,
          local: localBranches,
          remote: Array.from(new Set(remoteBranches)),
        });
      } catch (error) {
        return res.json({
          defaultBranch: repo.defaultBranch,
          local: [],
          remote: [],
          error: error instanceof Error ? error.message : "git_branches_failed",
        });
      }
    }),
  );

  app.patch(
    "/api/repos/:repoId",
    asyncRoute(async (req, res) => {
      const repoId = String(req.params.repoId);
      const patch = req.body ?? {};
      const allowed: Record<string, unknown> = {};
      if (typeof patch.name === "string" && patch.name.length) allowed.name = patch.name;
      if (typeof patch.worktreeParent === "string" && patch.worktreeParent.length)
        allowed.worktreeParent = patch.worktreeParent;
      if (Array.isArray(patch.setupHookIds))
        allowed.setupHookIds = patch.setupHookIds.filter((id: unknown) => typeof id === "string");
      if (Array.isArray(patch.teardownHookIds))
        allowed.teardownHookIds = patch.teardownHookIds.filter((id: unknown) => typeof id === "string");
      if (Array.isArray(patch.providerIds))
        allowed.providerIds = patch.providerIds.filter((id: unknown) => typeof id === "string");
      if (typeof patch.deployHookCommand === "string")
        allowed.deployHookCommand = patch.deployHookCommand.trim() || null;
      else if (patch.deployHookCommand === null) allowed.deployHookCommand = null;
      const next = store.updateRepo(repoId, allowed);
      if (!next) return res.status(404).json({ error: "repo_not_found" });
      emit("repo.updated", { repoId: next.id, repo: next });
      res.json({ repo: next });
    }),
  );

  app.post(
    "/api/repos/:repoId/refresh",
    asyncRoute(async (req, res) => {
      const repo = store.listRepos().find((candidate) => candidate.id === req.params.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const prefixes = [`vc:${repo.id}`, `ci:${repo.id}`];
      bustCacheByPrefixes(providerCache, prefixes);
      emit("repo.refreshed", { repoId: repo.id });
      res.json({ refreshed: prefixes });
    }),
  );
}
