import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CitadelConfig } from "@citadel/config";
import { mergeConfigPatch, saveConfig } from "@citadel/config";
import {
  type AppEvent,
  CreateAgentSessionInputSchema,
  CreateRepoInputSchema,
  CreateWorkspaceInputSchema,
  HookActionSchema,
  TransitionIssueInputSchema,
  type WorkspaceCockpitSummary,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus, mcpToolDefinitions } from "@citadel/mcp";
import { OperationService } from "@citadel/operations";
import {
  collectGitHubCiRunLog,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectJiraIssueSummary,
  collectProviderHealth,
  setGithubCommand,
  setJiraCommand,
  transitionJiraIssue,
} from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import { attachTerminalWebSocket, createTtydManager, ensureTmuxSession } from "@citadel/terminal";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { registerAgentSessionRoutes } from "./agent-session-routes.js";
import { asyncRoute, cachedProviderValue } from "./app-helpers.js";
import { getBootRestoreSummary } from "./boot-restore.js";
import { callDaemonMcpTool, readMcpResource } from "./daemon-mcp-tool.js";
import { registerWorkspaceExtraRoutes } from "./extra-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerNamespaceRoutes } from "./namespace-routes.js";
import { deriveReadiness, workspaceAppHookSample } from "./readiness.js";
import { registerRestoreRoutes } from "./restore-routes.js";
import { registerRuntimeUsageRoutes } from "./runtime-usage-routes.js";
import { registerScheduledAgentRoutes } from "./scheduled-agent-routes.js";
import { backfillIfEmpty } from "./scratchpad-history.js";
import { registerScratchpadRoutes } from "./scratchpad-routes.js";
import { scratchpadPath } from "./scratchpad.js";
import { startDaemonStatusMonitor } from "./status-monitor-wiring.js";
import { registerTerminalRoutes } from "./terminal-routes.js";
import { registerWorkspaceDiffRoutes } from "./workspace-diff-routes.js";
import { readWorkspaceGitStatus } from "./workspace-diff.js";
import { bustCacheByPrefixes, createWorkspaceFsWatchers } from "./workspace-fs-watcher.js";

export type DaemonApp = {
  app: express.Express;
  server: http.Server;
  emit: (type: string, payload: unknown) => void;
};

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectGitHubCiRunLog: typeof collectGitHubCiRunLog;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
  transitionJiraIssue: typeof transitionJiraIssue;
};

export function createDaemonApp(input: {
  config: CitadelConfig;
  configPath: string;
  store: SqliteStore;
  operations?: OperationService;
  providers?: Partial<ProviderCollectors>;
}): DaemonApp {
  const { config, configPath, store } = input;
  setGithubCommand(config.providers.github.command);
  setJiraCommand(config.providers.jira.command);
  const operations = input.operations ?? new OperationService(store, config);
  const providers: ProviderCollectors = {
    collectGitHubVersionControlSummary,
    collectGitHubCiRuns,
    collectGitHubCiRunLog,
    collectJiraIssueSummary,
    transitionJiraIssue,
    ...input.providers,
  };
  const app = express();
  const server = http.createServer(app);
  const sseClients = new Set<express.Response>();
  const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
  // Per-daemon ttyd port slice. Boot-time cleanupStale() blanket-SIGTERMs
  // every ttyd in this range, so any two daemons that share a range will
  // trample each other's live terminals (worktree daemons under tsx watch
  // restart on file save, and each restart killed the systemd install's
  // ttyds — that's where the "Reconnecting/Reconnected" storm came from).
  //
  // Slot = ((daemonPort - 4010) mod 11) * 200 gives 11 disjoint 200-port
  // slices, each deterministic per HTTP port. The base is shifted to 7721
  // (just above the legacy hardcoded ceiling of 7720) so daemons running
  // OLD pre-slot code — whose cleanupStale still targets the legacy
  // 7681..7720 range — physically cannot reach new daemons' terminals.
  // Env overrides still win so operators can pin the range explicitly.
  const ttydSlot = (((config.port - 4010) % 11) + 11) % 11;
  const envTtydBase = Number.parseInt(process.env.CITADEL_TTYD_PORT_BASE ?? "", 10);
  const envTtydMax = Number.parseInt(process.env.CITADEL_TTYD_PORT_MAX ?? "", 10);
  const ttydPortBase = Number.isFinite(envTtydBase) && envTtydBase > 0 ? envTtydBase : 7721 + 200 * ttydSlot;
  const ttydPortMax = Number.isFinite(envTtydMax) && envTtydMax > 0 ? envTtydMax : ttydPortBase + 199;
  const ttyd = createTtydManager({ portBase: ttydPortBase, portMax: ttydPortMax });

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  let fsWatchers: { reconcile: () => void; close: () => void } | null = null;
  const emit = (type: string, payload: unknown) => {
    const event: AppEvent = {
      id: `sse_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      source: "daemon",
      payload,
    };
    for (const client of sseClients) client.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (fsWatchers && (type === "workspace.updated" || type === "state.reconciled" || type === "repo.updated")) {
      fsWatchers.reconcile();
    }
  };

  // Terminal/ttyd proxy must register before the SPA fallback so it owns /terminals/*.
  //
  // Skip cleanupStale() when running under vitest. Every test that boots a
  // daemon (~20 of them) derives the same slot 0 range as the production
  // install for config.port=4010 — running cleanupStale() in tests would
  // SIGTERM the live cockpit's ttyds on every test that calls
  // createDaemonApp(). Production daemons still get the boot-time sweep.
  if (!process.env.VITEST) {
    const initialTerminalCleanup = ttyd.cleanupStale();
    if (initialTerminalCleanup.killed > 0) emit("terminal.cleanup", initialTerminalCleanup);
  }
  const respawnTmux = async (session: import("@citadel/contracts").AgentSession) => {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    const runtime = config.runtimes.find((candidate) => candidate.id === session.runtimeId);
    if (!workspace || !runtime) return null;
    const sessionName = session.tmuxSessionName ?? `citadel_${workspace.id}_${session.id.slice(-8)}`;
    return ensureTmuxSession({ sessionName, cwd: workspace.path, command: runtime.command, args: runtime.args });
  };
  registerTerminalRoutes({ app, server, store, ttyd, dataDir: config.dataDir, emit, respawnTmux });

  const cachedProviderHealth = () =>
    cachedProvider("provider-health", () => collectProviderHealth(config.providers), 15_000);

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const providerHealth = await cachedProviderHealth();
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
      const providerHealth = await cachedProviderHealth();
      res.json({
        repos,
        workspaces,
        sessions,
        operations: store.listOperations(),
        activity: store.listActivity(),
        providerHealth,
        runtimes: listRuntimeHealth(config.runtimes),
        mcp: mcpStatus(config.mcp.enabled),
        scheduledAgents: scheduledAgents.list(),
        namespaces: store.listNamespaces(),
        bootRestore: getBootRestoreSummary(),
      });
    }),
  );

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
    const input = CreateRepoInputSchema.parse(req.body);
    const repo = operations.registerRepo(input);
    emit("repo.updated", { repoId: repo.id, repo });
    res.status(201).json({ repo });
  });

  app.post(
    "/api/repos/inspect",
    asyncRoute(async (req, res) => {
      const inputPath = typeof req.body?.rootPath === "string" ? req.body.rootPath : "";
      if (!inputPath) return res.status(400).json({ error: "root_path_required" });
      const resolved = path.resolve(inputPath);
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
    "/api/repos/:repoId/provider-summary",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const versionControl = await cachedProvider(`vc:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubVersionControlSummary(repo.rootPath),
      );
      res.json({ versionControl });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const ci = await cachedProvider(`ci:${repo.id}:${repo.updatedAt}`, () =>
        providers.collectGitHubCiRuns(repo.rootPath),
      );
      res.json({ ci });
    }),
  );

  app.get(
    "/api/repos/:repoId/ci-runs/:runId/logs",
    asyncRoute(async (req, res) => {
      const repoId = req.params.repoId;
      const runId = req.params.runId;
      if (typeof repoId !== "string") return res.status(400).json({ error: "repo_id_required" });
      if (typeof runId !== "string") return res.status(400).json({ error: "run_id_required" });
      const repo = store.listRepos().find((candidate) => candidate.id === repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const log = await providers.collectGitHubCiRunLog(repo.rootPath, runId);
      res.json({ log });
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

  app.get(
    "/api/workspaces/:workspaceId/issue-summary",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const issueTracker = await cachedProvider(`issue:${workspace.issueKey}`, () =>
        providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
      );
      res.json({ issueTracker });
    }),
  );

  app.get(
    "/api/workspaces/:workspaceId/cockpit-summary",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });

      const [git, versionControl, ci, issueTracker, apps] = await Promise.all([
        cachedProvider(
          `git:${workspace.id}:${workspace.updatedAt}`,
          () => readWorkspaceGitStatus(workspace.path),
          3000,
        ),
        cachedProvider(`vc:${workspace.id}:${workspace.updatedAt}`, () =>
          providers.collectGitHubVersionControlSummary(workspace.path),
        ),
        cachedProvider(`ci:${workspace.id}:${workspace.updatedAt}`, () =>
          providers.collectGitHubCiRuns(workspace.path),
        ),
        workspace.issueKey
          ? cachedProvider(`issue:${workspace.issueKey}`, () =>
              providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
            )
          : Promise.resolve(null),
        cachedProvider(
          `apps:${workspace.id}:${workspace.updatedAt}`,
          () => operations.discoverWorkspaceApps({ repo, workspace }),
          60_000,
        ),
      ]);
      const summary: WorkspaceCockpitSummary = {
        workspaceId: workspace.id,
        readiness: deriveReadiness({
          workspace,
          sessions: store.listSessions(workspace.id),
          operations: store.listOperations().filter((operation) => operation.workspaceId === workspace.id),
          providerHealth: await cachedProviderHealth(),
          git,
          versionControl,
          ci,
          apps,
        }),
        git,
        versionControl,
        ci,
        issueTracker,
        apps,
      };
      res.json(summary);
    }),
  );

  app.get("/api/repos/:repoId/hook-diagnostics", (req, res) => {
    const repo = store.listRepos().find((candidate) => candidate.id === req.params.repoId);
    if (!repo) return res.status(404).json({ error: "repo_not_found" });
    const workspace = store.listWorkspaces(repo.id)[0] ?? null;
    res.json({
      diagnostics: operations.hookDiagnostics(repo, workspace),
      sample: workspaceAppHookSample(),
    });
  });

  app.post(
    "/api/workspaces/:workspaceId/actions",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
      if (!repo) return res.status(404).json({ error: "repo_not_found" });
      const action = HookActionSchema.parse(req.body);
      const result = await operations.runWorkspaceAction({ repo, workspace, action });
      providerCache.delete(`apps:${workspace.id}:${workspace.updatedAt}`);
      emit("workspace.action", { workspaceId: workspace.id, operationId: result.operationId, status: result.status });
      res.status(result.status === "succeeded" ? 202 : 424).json(result);
    }),
  );

  app.post(
    "/api/workspaces/:workspaceId/issue-transition",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const input = TransitionIssueInputSchema.parse(req.body);
      const result = await providers.transitionJiraIssue({
        issueKey: workspace.issueKey,
        transition: input.transition,
        fields: input.fields,
      });
      providerCache.delete(`issue:${workspace.issueKey}`);
      emit("provider.issue_transition", { workspaceId: workspace.id, issueKey: workspace.issueKey, result });
      res.status(result.status === "healthy" ? 202 : 424).json({ result });
    }),
  );

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

  registerRuntimeUsageRoutes({ app, config, asyncRoute, providerCache, cachedProvider });

  app.post(
    "/api/agent-sessions",
    asyncRoute(async (req, res) => {
      const input = CreateAgentSessionInputSchema.parse(req.body);
      const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
      if (!runtime) return res.status(404).json({ error: "runtime_not_found" });
      const session = await operations.createAgentSession(input, {
        command: runtime.command,
        args: runtime.args,
        displayName: runtime.displayName,
        promptArg: runtime.promptArg ?? null,
        sessionIdArg: runtime.sessionIdArg ?? null,
        resumeArg: runtime.resumeArg ?? null,
      });
      emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      res.status(202).json({ session });
    }),
  );

  app.delete(
    "/api/agent-sessions/:sessionId",
    asyncRoute(async (req, res) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string") return res.status(400).json({ error: "session_id_required" });
      const result = operations.stopAgentSession({ sessionId });
      if (!result.stopped) return res.status(404).json(result);
      ttyd.release(sessionId);
      emit("agent.updated", { sessionId });
      res.status(202).json(result);
    }),
  );

  registerAgentSessionRoutes(app, { operations, emit, asyncRoute });
  registerRestoreRoutes(app, { store, operations, config, emit, asyncRoute });

  app.post(
    "/api/reconcile",
    asyncRoute(async (_req, res) => {
      const result = operations.reconcile();
      providerCache.clear();
      emit("state.reconciled", result);
      res.json(result);
    }),
  );

  app.post(
    "/api/operations/:operationId/cancel",
    asyncRoute(async (req, res) => {
      const operationId = String(req.params.operationId);
      const result = operations.cancelOperation(operationId);
      if (!result.cancelled) return res.status(409).json(result);
      emit("operation.updated", { operationId });
      res.status(202).json(result);
    }),
  );

  app.post(
    "/api/operations/:operationId/retry",
    asyncRoute(async (req, res) => {
      const operationId = String(req.params.operationId);
      const result = await operations.retryOperation(operationId);
      if (!result.retried) return res.status(409).json(result);
      emit("operation.updated", { operationId });
      res.status(202).json(result);
    }),
  );

  app.get("/api/operations", (_req, res) => {
    res.json({ operations: store.listOperations() });
  });

  app.get("/api/operations/:operationId", (req, res) => {
    const operation = store.findOperation(String(req.params.operationId));
    if (!operation) return res.status(404).json({ error: "operation_not_found" });
    res.json({ operation });
  });

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

  app.get(
    "/api/workspaces/:workspaceId/pr-diff",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const exec = promisify(execFileCb);
        const { stdout } = await exec(config.providers.github.command ?? "gh", ["pr", "diff"], {
          cwd: workspace.path,
          timeout: 12_000,
          maxBuffer: 4 * 1024 * 1024,
        });
        const truncated = stdout.length > 256 * 1024;
        res.json({
          provider: "github-gh",
          truncated,
          diff: stdout.slice(0, 256 * 1024),
          checkedAt: new Date().toISOString(),
        });
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

  app.post(
    "/api/workspaces/:workspaceId/refresh",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      // Bust everything that hangs off this workspace identity.
      const prefixes = [
        `git:${workspace.id}`,
        `vc:${workspace.id}`,
        `ci:${workspace.id}`,
        `apps:${workspace.id}`,
        workspace.issueKey ? `issue:${workspace.issueKey}` : null,
      ].filter(Boolean) as string[];
      bustCacheByPrefixes(providerCache, prefixes);
      emit("workspace.refreshed", { workspaceId: workspace.id });
      res.json({ refreshed: prefixes });
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

  const { runner: scheduledAgents, service: scheduledAgentService } = registerScheduledAgentRoutes({
    app,
    server,
    store,
    operations,
    config,
    emit,
    asyncRoute,
  });
  // Boot-sweep: close any 'running' run rows that were in flight when the
  // daemon last died, sync the denormalized lastRunStatus cache on the
  // affected agents, kill orphan background tmux sessions, and drain queued
  // rows that were waiting on the failed in-flight predecessors. Best-effort:
  // we don't want a sweep failure to block startup, but we DO want a signal
  // because a silent failure leaves orphaned 'running' rows behind.
  void scheduledAgents.recoverInFlightRuns().catch((error) => {
    console.error("[citadel] scheduledAgents.recoverInFlightRuns failed:", error);
  });

  const mcpDeps = { config, store, operations, ttyd, scheduledAgents, scheduledAgentService, providerCache, emit };
  registerMcpRoutes(app, asyncRoute, {
    config,
    store,
    callDaemonMcpTool: (call) => callDaemonMcpTool(mcpDeps, call),
    readMcpResource: (uri) => readMcpResource(store, config, uri),
  });

  registerWorkspaceExtraRoutes({ app, store, emit, asyncRoute, operations });
  registerNamespaceRoutes({ app, store, operations, emit, asyncRoute });
  registerScratchpadRoutes({ app, config, emit });
  try {
    const spPath = scratchpadPath(config.dataDir);
    if (fs.existsSync(spPath)) {
      const content = fs.readFileSync(spPath, "utf8");
      if (content.length > 0) {
        const stat = fs.statSync(spPath);
        backfillIfEmpty(config.dataDir, { content, updatedAt: stat.mtime.toISOString() });
      }
    }
  } catch (error) {
    console.error(`[scratchpad-history] backfill skipped: ${error instanceof Error ? error.message : error}`);
  }

  fsWatchers = createWorkspaceFsWatchers({
    listWorkspaces: () => store.listWorkspaces(),
    providerCache,
    emit,
  });
  fsWatchers.reconcile();
  server.on("close", () => fsWatchers?.close());

  registerWorkspaceDiffRoutes({ app, store, asyncRoute });

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

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    app.use(express.static(webDist, { index: false }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path === "/events") return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      return res.status(400).json({
        error: "validation_failed",
        issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    const message = error instanceof Error ? error.message : "request_failed";
    res.status(400).json({ error: message });
  });

  // Diagnostic xterm.js gateway. The cockpit uses ttyd via /terminals/* instead; this stays for tooling.
  attachTerminalWebSocket(server, (sessionId) => {
    const session = store.listSessions().find((candidate) => candidate.id === sessionId);
    return session?.tmuxSessionName ?? null;
  });

  // Reap orphan tmux sessions / ghost worktrees on a slow interval.
  if (process.env.CITADEL_DISABLE_REAPER !== "1") {
    const reaper = setInterval(() => {
      try {
        const before = JSON.stringify(operations.reconcile());
        if (before !== '{"sessions":0,"workspaces":0,"repos":0,"deletedSessions":0}')
          emit("state.reconciled", JSON.parse(before));
      } catch {
        /* non-fatal */
      }
    }, 30_000);
    reaper.unref();
    server.on("close", () => clearInterval(reaper));
  }

  // Status monitor — 2s tick observing tmux activity + bash-wrapper sentinels
  // and asking the runtime adapter for pane-derived status observations.
  // Updates agent_sessions.status and emits agent.updated SSE events. Wiring
  // lives in status-monitor-wiring.ts to keep this file under the 800-line gate.
  const statusMonitor = startDaemonStatusMonitor(store, emit);
  if (statusMonitor) {
    server.on("close", () => statusMonitor.stop());
  }

  return { app, server, emit };

  function cachedProvider<T>(key: string, load: () => T | Promise<T>, ttlMs = 10_000): Promise<T> {
    return cachedProviderValue(providerCache, key, load, ttlMs);
  }
}
