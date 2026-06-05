import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { mergeConfigPatch, saveConfig } from "@citadel/config";
import {
  CreateRepoInputSchema,
  CreateWorkspaceCheckoutInputSchema,
  CreateWorkspaceInputSchema,
} from "@citadel/contracts";
import { generateFunnyName, workspaceBranchName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { setGithubCommand, setJiraCommand } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type express from "express";
import type { asyncRoute as AsyncRoute, ProviderCache } from "./app-helpers.js";
import { bustCacheByPrefixes } from "./workspace-fs-watcher.js";
import { slug, uniqueWorkspaceRoot } from "./workspace-home-paths.js";

export function registerConfigRepoWorkspaceRoutes(input: {
  app: express.Express;
  config: CitadelConfig;
  configPath: string;
  store: SqliteStore;
  operations: OperationService;
  providerCache: ProviderCache;
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
      if (typeof patch.showMainWorkspace === "boolean") allowed.showMainWorkspace = patch.showMainWorkspace;
      if (typeof patch.deployHookCommand === "string")
        allowed.deployHookCommand = patch.deployHookCommand.trim() || null;
      else if (patch.deployHookCommand === null) allowed.deployHookCommand = null;
      const next = store.updateRepo(repoId, allowed);
      if (!next) return res.status(404).json({ error: "repo_not_found" });
      emit("repo.updated", { repoId: next.id, repo: next });
      res.json({ repo: next });
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

  app.post(
    "/api/workspaces/home",
    asyncRoute(async (req, res) => {
      const raw = asRecord(req.body);
      if (raw.repoId !== undefined || raw.rootPath !== undefined) {
        return res.status(400).json({ error: "structured_workspace_home_is_repo_less" });
      }
      const parsed = CreateWorkspaceInputSchema.parse(raw);
      const { mode: _mode, repoId: _repoId, rootPath: _rootPath, ...homeInput } = parsed;
      const requestedName = stringField(raw.name);
      const rootPath = uniqueWorkspaceRoot(config.dataDir, requestedName ?? generateFunnyName());
      const result = await operations.createWorkspace({
        ...homeInput,
        name: requestedName ?? path.basename(rootPath),
        mode: "structured",
        rootPath,
      });
      emit("workspace.updated", result);
      res.status(202).json(result);
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/checkouts",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const raw = asRecord(req.body);
      const repoId = stringField(raw.repoId);
      const repo = repoId ? store.listRepos().find((candidate) => candidate.id === repoId) : null;
      if (!repo) return res.status(404).json({ error: "repo_not_found" });

      const source = checkoutSource(raw.source, raw.branch);
      const issueKey = stringField(raw.issueKey);
      const name = uniqueCheckoutName({
        workspace,
        checkouts: store.listWorkspaceCheckouts(workspace.id),
        rawName: raw.name,
        issueKey,
      });
      const branch = uniqueCheckoutBranch({
        repo,
        branch: raw.branch,
        name,
        issueKey,
        source,
        workspaces: store.listWorkspaces(),
        store,
      });
      const issue = issueBinding(raw);
      const displayName = stringField(raw.displayName) ?? stringField(raw.name);
      const parsed = CreateWorkspaceCheckoutInputSchema.parse({
        workspaceId,
        repoId: repo.id,
        name,
        ...(displayName ? { displayName } : {}),
        branch,
        source,
        ...(stringField(raw.baseBranch) ? { baseBranch: stringField(raw.baseBranch) } : {}),
        ...(issue ? { issue } : {}),
      });
      const result = await operations.createWorkspaceCheckout(parsed);
      emit("workspace.updated", { workspaceId, checkoutId: result.checkoutId, operationId: result.operationId });
      res.status(202).json({ workspaceId, ...result });
    }),
  );

  app.delete(
    "/api/workspaces/:workspaceId/checkouts/:checkoutId",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      const checkoutId = req.params.checkoutId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      if (typeof checkoutId !== "string") return res.status(400).json({ error: "checkout_id_required" });
      try {
        const result = await operations.removeWorkspaceCheckout({
          workspaceId,
          checkoutId,
          force: req.query.force === "true",
        });
        emit("workspace.updated", { workspaceId, checkoutId, operationId: result.operationId });
        res.status(result.removed ? 202 : 409).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "checkout_remove_failed";
        res.status(404).json({ error: message });
      }
    }),
  );

  app.patch(
    "/api/workspaces/:workspaceId/checkouts/:checkoutId",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      const checkoutId = req.params.checkoutId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      if (typeof checkoutId !== "string") return res.status(400).json({ error: "checkout_id_required" });
      const checkout = store.findWorkspaceCheckout(checkoutId);
      if (!checkout || checkout.workspaceId !== workspaceId)
        return res.status(404).json({ error: "checkout_not_found" });
      const raw = asRecord(req.body);
      const displayName = stringField(raw.displayName);
      const next = store.updateWorkspaceCheckoutDisplayName(checkoutId, displayName ?? null);
      emit("workspace.updated", { workspaceId, checkoutId });
      res.json({ checkout: next });
    }),
  );

  app.get("/api/agent-runtimes", (_req, res) => {
    res.json({ agentRuntimes: listRuntimeHealth(config.agentRuntimes) });
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function checkoutSource(value: unknown, branch: unknown): "default_branch" | "existing_branch" | "pr" {
  if (value === "default_branch" || value === "existing_branch" || value === "pr") return value;
  return stringField(branch) ? "existing_branch" : "default_branch";
}

function explicitCheckoutName(value: unknown, issueKey: string | null): string | null {
  const explicit = stringField(value);
  if (explicit) return slug(explicit);
  if (issueKey) return slug(issueKey);
  return null;
}

function uniqueCheckoutName(input: {
  workspace: { name: string; rootPath?: string | null | undefined; path: string };
  checkouts: Array<{ name: string }>;
  rawName: unknown;
  issueKey: string | null;
}): string {
  const existingNames = new Set(input.checkouts.map((checkout) => checkout.name));
  const rootPath = input.workspace.rootPath ?? input.workspace.path;
  const base = explicitCheckoutName(input.rawName, input.issueKey);
  if (!base) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const candidate = slug(generateFunnyName());
      if (!existingNames.has(candidate) && !fs.existsSync(path.join(rootPath, candidate))) return candidate;
    }
    const fallback = slug(generateFunnyName());
    return `${fallback}-${Date.now().toString(36)}`;
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!existingNames.has(candidate) && !fs.existsSync(path.join(rootPath, candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function uniqueCheckoutBranch(input: {
  repo: { id: string; rootPath: string; defaultRemote: string };
  branch: unknown;
  name: string;
  issueKey: string | null;
  source: "default_branch" | "existing_branch" | "pr";
  workspaces: Array<{ id: string }>;
  store: SqliteStore;
}): string {
  const explicit = stringField(input.branch);
  if (explicit) return explicit;
  const base = workspaceBranchName({
    name: input.name,
    source: input.issueKey ? "issue" : input.source === "pr" ? "pr" : "scratch",
    ...(input.issueKey ? { issueKey: input.issueKey } : {}),
  });
  const existingCheckoutBranches = new Set(
    input.workspaces
      .flatMap((workspace) => input.store.listWorkspaceCheckouts(workspace.id))
      .filter((checkout) => checkout.repoId === input.repo.id)
      .map((checkout) => checkout.branch),
  );
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (
      !existingCheckoutBranches.has(candidate) &&
      !branchRefExists(input.repo.rootPath, input.repo.defaultRemote, candidate)
    )
      return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function branchRefExists(cwd: string, remote: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return remoteBranchExists(cwd, remote, branch);
  }
}

function remoteBranchExists(cwd: string, remote: string, branch: string): boolean {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

function issueBinding(raw: Record<string, unknown>) {
  const key = stringField(raw.issueKey);
  if (!key) return null;
  return {
    provider: "jira" as const,
    key: key.toUpperCase(),
    url: stringField(raw.issueUrl),
    title: stringField(raw.issueTitle),
    status: null,
    fetchedAt: null,
  };
}
