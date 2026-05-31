import type { CitadelConfig } from "@citadel/config";
import { mergeConfigPatch, saveConfig } from "@citadel/config";
import { CreateRepoInputSchema, CreateWorkspaceInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { setGithubCommand, setJiraCommand } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { asyncRoute as AsyncRoute } from "./app-helpers.js";

type ProviderCacheInvalidator = {
  clear: () => void;
};

export function registerConfigRepoWorkspaceRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  configPath: string;
  store: SqliteStore;
  operations: OperationService;
  providerCache: ProviderCacheInvalidator;
  emit: (type: string, payload: unknown) => void;
  asyncRoute: typeof AsyncRoute;
}): void {
  const { app, config, configPath, store, operations, providerCache, emit, asyncRoute } = input;

  app.get("/api/config", (_req, res) => {
    res.json({ config, configPath });
  });

  app.put("/api/config", (req, res) => {
    const nextConfig = mergeConfigPatch(config, req.body);
    const saved = saveConfig(nextConfig, configPath);
    Object.assign(config, saved);
    setGithubCommand(saved.providers.github.command);
    setJiraCommand(saved.providers.jira.command);
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
    const parsed = CreateRepoInputSchema.parse(req.body);
    const repo = operations.registerRepo(parsed);
    emit("repo.updated", { repoId: repo.id, repo });
    res.status(201).json({ repo });
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

  app.get("/api/workspaces", (_req, res) => {
    res.json({ workspaces: store.listWorkspaces() });
  });

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

  app.post(
    "/api/workspaces",
    asyncRoute(async (req, res) => {
      const parsed = CreateWorkspaceInputSchema.parse(req.body);
      const result = await operations.createWorkspace(parsed, {
        deferProvisioning: true,
        onWorkspaceUpdated: (payload) => emit("workspace.updated", payload),
      });
      emit("workspace.updated", result);
      res.status(202).json(result);
    }),
  );

  app.get("/api/runtimes", (_req, res) => {
    res.json({ runtimes: listRuntimeHealth(config.runtimes) });
  });
}
