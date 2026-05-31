import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { CitadelConfig } from "@citadel/config";
import type { GitHubQuotaResource, GitHubQuotaSummary } from "@citadel/contracts";
import { createId } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { resolveFixConflictsPrompt } from "@citadel/hooks";
import type { OperationService } from "@citadel/operations";
import { getGhCooldown, isRateLimitError, setGhCooldown } from "@citadel/providers";
import type express from "express";
import { AUTOMATED_GH_DISABLED_REASON, automatedGhEnabled } from "./gh-automation.js";

type Emit = (type: string, payload: unknown) => void;
type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
type AsyncRoute = (
  handler: AsyncHandler,
) => (req: express.Request, res: express.Response, next: express.NextFunction) => void;

const execFileAsync = promisify(execFile);
const GITHUB_QUOTA_CACHE_TTL_MS = 60_000;

export function registerWorkspaceExtraRoutes(input: {
  app: express.Express;
  store: SqliteStore;
  emit: Emit;
  asyncRoute: AsyncRoute;
  operations: OperationService;
  config: CitadelConfig;
}) {
  const { app, store, emit, asyncRoute, operations, config } = input;
  let githubQuotaCache: { expiresAt: number; value: GitHubQuotaSummary } | null = null;
  const resolveWorkspaceRepo = (workspaceId: string) => {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) return { ok: false as const, error: "workspace_not_found" as const };
    const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) return { ok: false as const, error: "repo_not_found" as const };
    return { ok: true as const, repo, workspace };
  };

  app.get(
    "/api/workspaces/:workspaceId/deployed-apps",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      try {
        const summary = await operations.listDeployedApps({ workspaceId });
        res.json(summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : "deploy_hook_list_failed";
        res.status(404).json({ error: message });
      }
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/deployed-apps/redeploy",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const body = (req.body ?? {}) as { name?: unknown };
      let appName: string | undefined;
      if (body.name !== undefined && body.name !== null && body.name !== "") {
        if (typeof body.name !== "string" || !/^[a-zA-Z0-9_.-]{1,80}$/.test(body.name.trim())) {
          return res.status(400).json({ error: "invalid_app_name" });
        }
        appName = body.name.trim();
      }
      try {
        const result = await operations.redeployApp({ workspaceId, appName });
        emit("workspace.deploy.redeploy", { workspaceId, operationId: result.operationId, status: result.status });
        res.status(result.status === "succeeded" ? 202 : 424).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "deploy_hook_redeploy_failed";
        res.status(404).json({ error: message });
      }
    }),
  );

  app.get("/api/workspaces/archived", (_req, res) => {
    res.json({ workspaces: store.listArchivedWorkspaces() });
  });

  app.get(
    "/api/workspaces/:workspaceId/removal-check",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      try {
        const result = operations.checkWorkspaceRemoval({
          workspaceId,
          archiveOnly: req.query.archiveOnly === "true",
        });
        res.status(result.removable ? 200 : 409).json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "workspace_removal_check_failed";
        res.status(404).json({ error: message });
      }
    }),
  );

  app.patch(
    "/api/workspaces/:workspaceId",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const patch = (req.body ?? {}) as Record<string, unknown>;
      const allowed: Parameters<typeof store.updateWorkspace>[1] = {};
      if (typeof patch.name === "string" && patch.name.trim().length) allowed.name = patch.name.trim();
      if (typeof patch.issueKey === "string" || patch.issueKey === null)
        allowed.issueKey = patch.issueKey as string | null;
      if (typeof patch.issueTitle === "string" || patch.issueTitle === null)
        allowed.issueTitle = patch.issueTitle as string | null;
      if (typeof patch.issueUrl === "string" || patch.issueUrl === null)
        allowed.issueUrl = patch.issueUrl as string | null;
      if (typeof patch.slackThreadUrl === "string" || patch.slackThreadUrl === null)
        allowed.slackThreadUrl = patch.slackThreadUrl as string | null;
      if (typeof patch.pinned === "boolean") allowed.pinned = patch.pinned;
      store.updateWorkspace(workspace.id, allowed);
      const next = store.listWorkspaces().find((candidate) => candidate.id === workspace.id);
      emit("workspace.updated", { workspaceId: workspace.id, workspace: next });
      res.json({ workspace: next });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/unarchive",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspace = store.listArchivedWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const exists = Boolean(workspace.path) && fs.existsSync(workspace.path);
      if (!exists) return res.status(409).json({ error: "workspace_path_missing" });
      store.unarchiveWorkspace(workspace.id);
      const next = store.listWorkspaces().find((candidate) => candidate.id === workspace.id);
      emit("workspace.updated", { workspaceId: workspace.id, workspace: next });
      res.json({ workspace: next });
    }),
  );

  const renameWorkspaceSession = asyncRoute(async (req: express.Request, res: express.Response) => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
    const patch = (req.body ?? {}) as Record<string, unknown>;
    const displayName = typeof patch.displayName === "string" ? patch.displayName.trim() : "";
    if (!displayName) return res.status(400).json({ error: "display_name_required" });
    const session = store.listWorkspaceSessions().find((candidate) => candidate.id === sessionId);
    if (!session) return res.status(404).json({ error: "session_not_found" });
    store.updateWorkspaceSessionDisplayName(sessionId, displayName);
    const updated = store.listWorkspaceSessions().find((candidate) => candidate.id === sessionId);
    emit(session.kind === "agent" ? "agent.updated" : "terminal.updated", { sessionId });
    res.json({ session: updated });
  });
  app.patch("/api/workspace-sessions/:sessionId", renameWorkspaceSession);
  app.patch("/api/agent-sessions/:sessionId", renameWorkspaceSession);

  // GitHub search/clone helpers used by the AddRepo modal. Both require gh to be
  // available and authenticated; failures surface as structured errors so the UI
  // can render an explicit empty state.
  app.get(
    "/api/integrations/github/quota",
    asyncRoute(async (_req: express.Request, res: express.Response) => {
      if (githubQuotaCache && githubQuotaCache.expiresAt > Date.now())
        return res.json({ quota: githubQuotaCache.value });
      const quota = await readGitHubQuota(config, githubQuotaCache?.value ?? null);
      if (quota.status !== "unavailable") {
        githubQuotaCache = { expiresAt: Date.now() + GITHUB_QUOTA_CACHE_TTL_MS, value: quota };
      } else if (!githubQuotaCache || githubQuotaCache.expiresAt <= Date.now()) {
        githubQuotaCache = { expiresAt: Date.now() + GITHUB_QUOTA_CACHE_TTL_MS, value: quota };
      }
      res.json({ quota });
    }),
  );

  app.get(
    "/api/integrations/github/search",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!query) return res.json({ results: [] });
      try {
        const { stdout } = await execFileAsync(
          config.providers.github.command ?? "gh",
          ["api", "--method", "GET", "search/repositories", "-f", `q=${query}`, "-f", "per_page=8"],
          { timeout: 10_000 },
        );
        const parsed = JSON.parse(stdout) as {
          items?: Array<{
            full_name?: unknown;
            html_url?: unknown;
            description?: unknown;
            default_branch?: unknown;
          } | null>;
        };
        res.json({
          results: (parsed.items ?? []).flatMap((entry) => {
            if (!entry || typeof entry.full_name !== "string" || typeof entry.html_url !== "string") return [];
            return [
              {
                name: entry.full_name,
                url: entry.html_url,
                description: typeof entry.description === "string" ? entry.description : undefined,
                defaultBranch: typeof entry.default_branch === "string" ? entry.default_branch : undefined,
              },
            ];
          }),
        });
      } catch (error) {
        res.status(200).json({ results: [], error: error instanceof Error ? error.message : "gh_search_failed" });
      }
    }),
  );

  app.post(
    "/api/integrations/github/clone",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const body = (req.body ?? {}) as { url?: string; targetDir?: string };
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url) return res.status(400).json({ error: "url_required" });
      const parent =
        body.targetDir && typeof body.targetDir === "string" ? body.targetDir : path.join(os.homedir(), "Workspace");
      try {
        fs.mkdirSync(parent, { recursive: true });
      } catch (error) {
        return res
          .status(500)
          .json({ error: "workspace_root_unwritable", detail: error instanceof Error ? error.message : "" });
      }
      const slug = (url.split("/").pop() || "repo").replace(/\.git$/, "");
      const rootPath = path.join(parent, slug);
      if (fs.existsSync(rootPath)) {
        return res.json({ rootPath, cloned: false });
      }
      try {
        await execFileAsync(config.providers.github.command ?? "gh", ["repo", "clone", url, rootPath], {
          timeout: 120_000,
        });
        res.json({ rootPath, cloned: true });
      } catch (error) {
        res.status(200).json({
          rootPath,
          cloned: false,
          error: error instanceof Error ? error.message : "gh_clone_failed",
        });
      }
    }),
  );

  app.get(
    "/api/integrations/issues/recent",
    asyncRoute(async (_req: express.Request, res: express.Response) => {
      // Issue providers are workspace-scoped today. Without an attached repo or workspace
      // we cannot identify the project, so we return an empty payload with an
      // explanatory error string the UI surfaces verbatim.
      res.status(200).json({ issues: [], error: "Configure a default issue provider to populate suggestions." });
    }),
  );

  // Launch a fresh agent to resolve a PR's merge conflicts. Always spawns a new
  // session (no de-duplication) per the design — operators can click multiple
  // times if they want multiple agents trying. The prompt is taken from a repo
  // `.citadel/hooks/fixconflicts` hook when present, else a hardcoded default
  // that references Citadel's non-fast-forward policy.
  app.post(
    "/api/workspaces/:workspaceId/fix-conflicts",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const resolvedWorkspace = resolveWorkspaceRepo(workspaceId);
      if (!resolvedWorkspace.ok) return res.status(404).json({ error: resolvedWorkspace.error });
      const { repo, workspace } = resolvedWorkspace;
      const hookResult = await operations.runHookEvent({
        event: "merge.conflict.detected",
        repo,
        workspace,
        operationType: "merge.conflict.detected",
        operationMessage: "Running merge-conflict hooks",
        payload: { reason: "operator-requested", request: req.body ?? {} },
      });
      if (hookResult.ran > 0) {
        emit("operation.updated", { operationId: hookResult.operationId });
        emit("agent.updated", { workspaceId: workspace.id });
        return res.status(202).json({ hooked: true, operationId: hookResult.operationId, promptSource: "hook" });
      }
      // Require a non-shell agent runtime. The fix-conflicts prompt is
      // multi-line ("git pull origin main", "make check", "git push"); if it
      // were pasted into a bash/sh/zsh/fish tmux pane those would execute
      // line-by-line as shell commands. The invariant is "the runtime is an
      // agent TUI, not a plain shell" — checked against the runtime's command.
      // We do NOT require runtime.promptArg: the canonical claude-code
      // runtime intentionally omits it (Claude's `-p` is non-interactive
      // print mode), and createAgentSession pastes the prompt into the TUI
      // once it's ready. Pasting multi-line text into an agent TUI is safe
      // since the TUI treats it as user input, not as a shell command.
      const isShellCommand = (cmd: string) => ["bash", "sh", "zsh", "fish"].includes(cmd);
      const requestedRuntimeId = typeof req.body?.runtimeId === "string" ? req.body.runtimeId : undefined;
      const runtime = requestedRuntimeId
        ? config.agentRuntimes.find((candidate) => candidate.id === requestedRuntimeId)
        : config.agentRuntimes.find((candidate) => !isShellCommand(candidate.command));
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });
      if (isShellCommand(runtime.command)) return res.status(400).json({ error: "runtime_must_be_agent" });
      const resolved = await resolveFixConflictsPrompt({
        workspacePath: workspace.path,
        workspaceId: workspace.id,
        workspaceBranch: workspace.branch,
        repoId: repo.id,
      });
      const session = await operations.createAgentSession(
        {
          workspaceId: workspace.id,
          runtimeId: runtime.id,
          displayName: "Fix conflicts",
          prompt: resolved.prompt,
        },
        {
          command: runtime.command,
          args: runtime.args,
          displayName: runtime.displayName,
          promptArg: runtime.promptArg ?? null,
          sessionIdArg: runtime.sessionIdArg ?? null,
          resumeArg: runtime.resumeArg ?? null,
        },
      );
      // Distinguish operator-triggered fix-conflicts launches from the generic
      // agent.started event so the activity log can filter on intent. Per the
      // plan: type=agent.fix-conflicts.launched, source=user. createAgentSession
      // also emits its own agent.started row — that's intentional. Filter by
      // type when surfacing fix-conflicts in the UI.
      store.addActivity({
        id: createId("evt"),
        type: "agent.fix-conflicts.launched",
        source: "user",
        repoId: repo.id,
        workspaceId: workspace.id,
        operationId: null,
        message: `Launched fix-conflicts agent (prompt: ${resolved.source})`,
        createdAt: new Date().toISOString(),
      });
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session, promptSource: resolved.source, diagnostic: resolved.diagnostic });
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/review-requested",
    asyncRoute(async (req: express.Request, res: express.Response) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const resolvedWorkspace = resolveWorkspaceRepo(workspaceId);
      if (!resolvedWorkspace.ok) return res.status(404).json({ error: resolvedWorkspace.error });
      const { repo, workspace } = resolvedWorkspace;
      const body = (req.body ?? {}) as { reason?: unknown };
      const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "manual";
      const hookResult = await operations.runHookEvent({
        event: "review.requested",
        repo,
        workspace,
        operationType: "review.requested",
        operationMessage: "Running review-requested hooks",
        payload: { reason, request: req.body ?? {} },
      });
      emit("operation.updated", { operationId: hookResult.operationId });
      if (hookResult.ran === 0)
        return res
          .status(404)
          .json({ hooked: false, operationId: hookResult.operationId, error: "review_hook_not_found" });
      emit("agent.updated", { workspaceId: workspace.id });
      res.status(202).json({ hooked: true, operationId: hookResult.operationId });
    }),
  );
}

async function readGitHubQuota(
  config: CitadelConfig,
  previous: GitHubQuotaSummary | null,
): Promise<GitHubQuotaSummary> {
  const checkedAt = new Date().toISOString();
  const automationEnabled = automatedGhEnabled();
  const cooldown = getGhCooldown();
  if (!automationEnabled) {
    return {
      providerId: "github-gh",
      status: "unavailable",
      reason: AUTOMATED_GH_DISABLED_REASON,
      checkedAt,
      cooldownUntil: null,
      automationEnabled,
      resources: previous?.resources ?? [],
    };
  }
  if (!config.providers.github.enabled) {
    return {
      providerId: "github-gh",
      status: "unavailable",
      reason: "GitHub provider is disabled in config",
      checkedAt,
      cooldownUntil: null,
      automationEnabled,
      resources: previous?.resources ?? [],
    };
  }
  try {
    const { stdout } = await execFileAsync(config.providers.github.command ?? "gh", ["api", "rate_limit"], {
      timeout: 8000,
      maxBuffer: 256 * 1024,
    });
    const quota = normalizeGitHubQuota(stdout, checkedAt, automationEnabled);
    return applyQuotaCooldown(quota, cooldown ?? quotaCooldownFromResources(quota));
  } catch (error) {
    const reason = isRateLimitError(error);
    if (reason) {
      const until = setGhCooldown(reason);
      return {
        providerId: "github-gh",
        status: "degraded",
        reason,
        checkedAt,
        cooldownUntil: new Date(until).toISOString(),
        automationEnabled,
        resources: previous?.resources ?? [],
      };
    }
    return {
      providerId: "github-gh",
      status: "degraded",
      reason: cooldown?.reason ?? (error instanceof Error ? error.message : "GitHub quota lookup failed"),
      checkedAt,
      cooldownUntil: cooldown ? new Date(cooldown.until).toISOString() : null,
      automationEnabled,
      resources: previous?.resources ?? [],
    };
  }
}

function quotaCooldownFromResources(quota: GitHubQuotaSummary): { until: number; reason: string } | null {
  const exhausted = quota.resources.find(
    (resource) => (resource.name === "graphql" || resource.name === "core") && resource.remaining === 0,
  );
  if (!exhausted?.resetAt) return null;
  const resetMs = Date.parse(exhausted.resetAt);
  if (!Number.isFinite(resetMs) || resetMs <= Date.now()) return null;
  const reason = `GitHub ${exhausted.name} quota exhausted until ${exhausted.resetAt}`;
  const until = setGhCooldown(reason, Math.max(1, resetMs - Date.now()));
  return { until, reason };
}

function applyQuotaCooldown(
  quota: GitHubQuotaSummary,
  cooldown: { until: number; reason: string } | null,
): GitHubQuotaSummary {
  if (!cooldown) return quota;
  return {
    ...quota,
    status: "degraded",
    reason: cooldown.reason,
    cooldownUntil: new Date(cooldown.until).toISOString(),
  };
}

function normalizeGitHubQuota(raw: string, checkedAt: string, automationEnabled: boolean): GitHubQuotaSummary {
  const parsed = JSON.parse(raw) as { resources?: Record<string, Record<string, unknown>> };
  const resources: GitHubQuotaResource[] = [];
  for (const name of ["core", "graphql", "search"] as const) {
    const entry = parsed.resources?.[name];
    if (!entry) continue;
    const limit = readNonNegativeInt(entry.limit);
    const remaining = readNonNegativeInt(entry.remaining);
    const reset = readNonNegativeInt(entry.reset);
    if (limit === null || remaining === null) continue;
    const usedFromPayload = readNonNegativeInt(entry.used);
    const used = usedFromPayload ?? Math.max(0, limit - remaining);
    const percentUsed = limit > 0 ? Math.min(100, Math.max(0, Math.round((used / limit) * 100))) : 0;
    resources.push({
      name,
      limit,
      used,
      remaining,
      percentUsed,
      resetAt: reset === null ? null : new Date(reset * 1000).toISOString(),
    });
  }
  return {
    providerId: "github-gh",
    status: resources.length > 0 ? "healthy" : "degraded",
    reason: resources.length > 0 ? null : "GitHub quota response had no rate resources",
    checkedAt,
    cooldownUntil: null,
    automationEnabled,
    resources,
  };
}

function readNonNegativeInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}
