import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CitadelConfig } from "@citadel/config";
import { type AppEvent, HookActionSchema, TransitionIssueInputSchema } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus } from "@citadel/mcp";
import { type DiagnosticsLogger, OperationService, createDiagnosticsLogger } from "@citadel/operations";
import {
  type CollectGitHubVersionControlSummaryDeps,
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
import { attachTerminalWebSocket, tmuxSessionExists } from "@citadel/terminal";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { registerAgentSessionRoutes } from "./agent-session-routes.js";
import { asyncRoute, cachedProviderValue, cachedProviderWithStaleFallback } from "./app-helpers.js";
import { startDaemonAutoRecoveryMonitor } from "./auto-recovery-wiring.js";
import { startDaemonAutoResumeLoop } from "./auto-resume-wiring.js";
import { registerCitadelActionRoutes } from "./citadel-actions-routes.js";
import { createWorkspaceCockpitSummaryBuilder, registerCockpitSummaryRoute } from "./cockpit-summary-route.js";
import { registerConfigRepoWorkspaceRoutes } from "./config-repo-workspace-routes.js";
import { callDaemonMcpTool, readMcpResource } from "./daemon-mcp-tool.js";
import { registerDiagnosticsRoutes } from "./diagnostics-routes.js";
import { E2E_RUN_ID_HEADER, e2eHealthFields, e2eRunIdMismatch } from "./e2e-guard.js";
import { registerWorkspaceExtraRoutes } from "./extra-routes.js";
import { AUTOMATED_GH_DISABLED_REASON, automatedGhEnabled } from "./gh-automation.js";
import { type GhQuotaWiringWithDetach, resolveRepoFullNameFromWorkspaces, wireGhQuota } from "./gh-quota-wiring.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerNamespaceRoutes } from "./namespace-routes.js";
import { registerPrDiffRoute } from "./pr-diff-route.js";
import { registerPrRoutes } from "./pr-routes.js";
import { createProviderCache, issueCacheKey } from "./provider-cache.js";
import { startProviderRefreshJob } from "./provider-refresh-job.js";
import { workspaceAppHookSample } from "./readiness.js";
import { registerRepoDiscoveryRoutes } from "./repo-discovery-routes.js";
import { registerRestoreRoutes } from "./restore-routes.js";
import { registerRuntimeUsageRoutes } from "./runtime-usage-routes.js";
import { registerScheduledAgentRoutes } from "./scheduled-agent-routes.js";
import { registerScratchpadRoutes } from "./scratchpad-routes.js";
import { backfillScratchpadOnStartup } from "./scratchpad.js";
import { registerStateRoute } from "./state-route.js";
import { startDaemonStatusMonitor } from "./status-monitor-wiring.js";
import { startTerminalReaper } from "./terminal-reaper.js";
import { buildRespawnTmux } from "./terminal-routes-helpers.js";
import { createUiActivityTracker } from "./ui-activity.js";
import { fetchVersionControlGated } from "./vc-fetch-gated.js";
import { registerWorkspaceDiffRoutes } from "./workspace-diff-routes.js";
import { bustCacheByPrefixes, createWorkspaceFsWatchers } from "./workspace-fs-watcher.js";
import { registerWorkspacesPrStateRoute } from "./workspaces-pr-state-route.js";

export type DaemonApp = {
  app: express.Express;
  server: http.Server;
  emit: (type: string, payload: unknown) => void;
  diagnostics: DiagnosticsLogger;
};

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectGitHubCiRunLog: typeof collectGitHubCiRunLog;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
  transitionJiraIssue: typeof transitionJiraIssue;
};

export async function createDaemonApp(input: {
  config: CitadelConfig;
  configPath: string;
  store: SqliteStore;
  operations?: OperationService;
  providers?: Partial<ProviderCollectors>;
  // Default true. Test helpers pass false so vitest boots don't spawn the
  // 15s background tick (and the implied `gh`/`jtk` subprocesses on tick).
  // Note: deliberately NOT gated on process.env.VITEST — that pattern would
  // silently disable the feature in production if the env var leaks.
  enableRefreshJob?: boolean;
}): Promise<DaemonApp> {
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
  // The daemon owns several legitimate close hooks (provider cache flush,
  // schedulers, status monitors, terminal cleanup). Keep Node from reporting
  // these as listener leaks in integration tests and diagnostics-heavy boots.
  server.setMaxListeners(24);
  // Node's 5s default keep-alive timeout is short enough for Playwright's
  // APIRequestContext to race a reused idle socket on slower CI runs, surfacing
  // as ECONNRESET even though the daemon is healthy. Keep browser/API
  // connections alive for a normal interaction gap instead.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  const sseClients = new Set<express.Response>();
  const providerCache = createProviderCache({
    dataDir: config.dataDir,
    // Both workspace ids AND repo ids appear as the "id" segment of vc:/ci:
    // cache keys (workspace via cockpit-summary, repo via the per-repo
    // provider-summary / ci-runs routes). The orphan prune treats them
    // homogeneously: keep entries whose id matches ANY live entity.
    listLiveIds: () => [...store.listWorkspaces().map((w) => w.id), ...store.listRepos().map((r) => r.id)],
  });
  // Hydrate the persisted cache BEFORE any route is registered so the first
  // post-restart request can hit warm cache. The load() is bounded by a 500ms
  // hard timeout — slow disks degrade to an empty cache but never block boot.
  await providerCache.load();
  // Always-on structured diagnostics. Writes JSONL to <dataDir>/diagnostics.jsonl
  // (rotated at 50 MB) and keeps the last 1000 events in memory for the
  // Settings → Debug panel + the /api/diagnostics/bundle.tar.gz download.
  // Sprinkled through every session-killing path so that when a user reports
  // "all my sessions died", we have the lifecycle trail to share.
  const diagnostics = createDiagnosticsLogger({ dataDir: config.dataDir });
  const uiActivity = createUiActivityTracker();
  diagnostics.log("daemon", "createDaemonApp", {
    port: config.port,
    dataDir: config.dataDir,
    worktree: process.env.CITADEL_WORKTREE === "1",
    pid: process.pid,
    nodeVersion: process.versions.node,
  });
  const resolveRepoFullName = (repoId: string) => resolveRepoFullNameFromWorkspaces(repoId, store);
  const ghQuota: GhQuotaWiringWithDetach = wireGhQuota({ sseClients, store, resolveRepoFullName });
  const ghAutomationEnabled = automatedGhEnabled();
  server.on("close", () => ghQuota.stop());
  const gatedVcDeps = {
    store,
    scheduler: ghQuota.scheduler,
    providerCache,
    collectVc: (path: string, deps?: CollectGitHubVersionControlSummaryDeps) =>
      providers.collectGitHubVersionControlSummary(path, deps),
    resolveRepoFullName,
    cachedProvider: <T>(k: string, l: () => T | Promise<T>, t?: number) => cachedProvider(k, l, t),
  };

  app.use(cors());
  app.use((req, res, next) => {
    const mismatch = e2eRunIdMismatch(req.get(E2E_RUN_ID_HEADER));
    if (!mismatch) return next();
    res.status(409).json(mismatch);
  });
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

  const recentUserAction = new Map<string, number>();
  const respawnTmuxForWebSocket = buildRespawnTmux(store, config);

  const cachedProviderHealth = () =>
    cachedProvider(
      "provider-health",
      () =>
        collectProviderHealth(
          config.providers,
          ghAutomationEnabled ? {} : { skipGithubReason: AUTOMATED_GH_DISABLED_REASON },
        ),
      60_000,
    );

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
        ...e2eHealthFields(config),
        degradedProviders: degradedProviders.length,
        providerHealth,
        mcp: mcpStatus(config.mcp.enabled),
        now: new Date().toISOString(),
      });
    }),
  );

  registerDiagnosticsRoutes({ app, store, diagnostics, config, uiActivity });
  registerConfigRepoWorkspaceRoutes({ app, config, configPath, store, operations, providerCache, emit, asyncRoute });

  app.post("/api/agent-sessions/:sessionId/terminal-client-event", (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
    const body = (req.body ?? {}) as Record<string, unknown>;
    diagnostics.log("terminal-client", typeof body.event === "string" ? body.event.slice(0, 80) : "unknown", {
      sessionId,
      path: typeof body.path === "string" ? body.path.slice(0, 240) : "",
      visibility: typeof body.visibility === "string" ? body.visibility.slice(0, 40) : "unknown",
    });
    res.status(204).end();
  });

  app.post("/api/agent-sessions/:sessionId/user-action", (req, res) => {
    const sessionId = typeof req.params.sessionId === "string" ? req.params.sessionId : "";
    recentUserAction.set(sessionId, Date.now());
    res.status(204).end();
  });
  registerRepoDiscoveryRoutes({ app, config, asyncRoute });

  app.get(
    "/api/workspaces/:workspaceId/issue-summary",
    asyncRoute(async (req, res) => {
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === req.params.workspaceId);
      if (!workspace) return res.status(404).json({ error: "workspace_not_found" });
      if (!workspace.issueKey) return res.status(404).json({ error: "workspace_issue_not_found" });
      const issueTracker = await cachedProviderSwr(issueCacheKey(workspace.issueKey), () =>
        providers.collectJiraIssueSummary(workspace.issueKey ?? ""),
      );
      res.json({ issueTracker });
    }),
  );

  const buildWorkspaceCockpitSummary = createWorkspaceCockpitSummaryBuilder({
    store,
    operations,
    providers,
    providerCache,
    cachedProvider,
    cachedProviderSwr,
    cachedProviderHealth,
    ghAutomationEnabled,
    resolveRepoFullName,
    fetchVersionControl: (workspace, repo, cacheKey) =>
      fetchVersionControlGated(gatedVcDeps, workspace, repo, cacheKey),
  });
  registerCockpitSummaryRoute({ app, buildWorkspaceCockpitSummary, asyncRoute });

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

  registerRuntimeUsageRoutes({ app, config, asyncRoute, providerCache, cachedProvider });
  registerPrRoutes({
    app,
    store,
    providers,
    asyncRoute,
    cachedProvider,
    providerCache,
    buildWorkspaceCockpitSummary,
    resolveRepoFullName,
  });

  registerAgentSessionRoutes(app, { operations, emit, asyncRoute, config });
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

  registerPrDiffRoute({ app, store, providerCache, asyncRoute });

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
      // Evict from the scheduler regardless of removed-vs-archived outcome.
      // An archived workspace has no UI presence either, so its cadence slot
      // is dead weight and (if it shared a PR with another workspace) the
      // workspaceIds refcount should drop. evict is a no-op if the id wasn't
      // tracked.
      if (result.removed || result.archived) {
        ghQuota.scheduler.evict(workspaceId);
      }
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
  // Extracted route registrations live here (post-scheduledAgents init) so the
  // /api/state handler can close over a fully-initialized runner. app.ts hit
  // the 800-line size gate, hence the extraction.
  registerStateRoute({ app, store, config, scheduledAgents, cachedProviderHealth, asyncRoute });
  registerWorkspacesPrStateRoute({ app, store, providerCache, asyncRoute });
  // Boot-sweep: close any 'running' run rows that were in flight when the
  // daemon last died, sync the denormalized lastRunStatus cache on the
  // affected agents, kill orphan background tmux sessions, and drain queued
  // rows that were waiting on the failed in-flight predecessors. Best-effort:
  // we don't want a sweep failure to block startup, but we DO want a signal
  // because a silent failure leaves orphaned 'running' rows behind.
  void scheduledAgents.recoverInFlightRuns().catch((error) => {
    console.error("[citadel] scheduledAgents.recoverInFlightRuns failed:", error);
  });

  const mcpDeps = { config, store, operations, scheduledAgents, scheduledAgentService, providerCache, emit };
  registerMcpRoutes(app, asyncRoute, {
    config,
    store,
    callDaemonMcpTool: (call) => callDaemonMcpTool(mcpDeps, call),
    readMcpResource: (uri) => readMcpResource(store, config, uri),
  });

  registerWorkspaceExtraRoutes({ app, store, emit, asyncRoute, operations, config });
  registerNamespaceRoutes({ app, store, operations, emit, asyncRoute });
  registerScratchpadRoutes({ app, config, emit, store, operations, providerHealth: cachedProviderHealth });
  registerCitadelActionRoutes({ app, config, emit });
  backfillScratchpadOnStartup(config);

  const refreshJob =
    input.enableRefreshJob !== false
      ? startProviderRefreshJob({
          config,
          store,
          cache: providerCache,
          providers: {
            collectGitHubVersionControlSummary: (rootPath) => providers.collectGitHubVersionControlSummary(rootPath),
            collectGitHubCiRuns: (rootPath) => providers.collectGitHubCiRuns(rootPath),
            collectJiraIssueSummary: (issueKey) => providers.collectJiraIssueSummary(issueKey),
            collectRuntimeUsage: (provider) =>
              import("@citadel/providers").then((mod) => mod.collectRuntimeUsage(provider)),
            listRuntimeHealth: () => listRuntimeHealth(config.runtimes),
          },
          hasFocusedWindow: () => uiActivity.hasFocusedWindow(),
        })
      : null;
  if (refreshJob) server.on("close", () => refreshJob.stop());

  if (process.env.CITADEL_DISABLE_FS_WATCHERS !== "1") {
    fsWatchers = createWorkspaceFsWatchers({
      listWorkspaces: () => store.listWorkspaces(),
      providerCache,
      emit,
      onSettled: refreshJob ? (workspaceId) => void refreshJob.pokeWorkspace(workspaceId) : undefined,
    });
    fsWatchers.reconcile();
    server.on("close", () => fsWatchers?.close());
  }

  server.on("close", () => {
    // Final synchronous flush so the persisted cache reflects in-memory state
    // at shutdown. Errors are logged inside dispose() and not re-thrown.
    void providerCache.dispose();
  });

  registerWorkspaceDiffRoutes({ app, store, asyncRoute });

  app.get("/events", (req, res) => {
    req.socket.setTimeout(0);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    sseClients.add(res);
    // Fire AFTER the add so hasViewers() in the wiring sees the new state.
    // 0→1 transition triggers scheduler.invalidateNotDue() so the next FE
    // poll fetches fresh instead of waiting for the cadence window.
    ghQuota.onViewerAttached();
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    req.on("close", () => {
      sseClients.delete(res);
      ghQuota.onViewerDetached(); // stamps lastDetachAt iff this was the last viewer
    });
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

  // Primary terminal gateway: xterm.js in the browser talks to a short-lived
  // node-pty `tmux attach-session` client. The tmux session remains durable;
  // the browser viewer is disposable and killed on WebSocket close.
  attachTerminalWebSocket(
    server,
    async (sessionId) => {
      const session = store.listSessions().find((candidate) => candidate.id === sessionId);
      if (!session) return null;
      if (session.tmuxSessionName && tmuxSessionExists(session.tmuxSessionName, session.tmuxSocketName ?? null)) {
        return { sessionName: session.tmuxSessionName, socketName: session.tmuxSocketName ?? null };
      }
      const respawn = await respawnTmuxForWebSocket(session);
      if (!respawn) return null;
      emit("terminal.ready", { sessionId: session.id, tmuxSession: respawn.tmuxSessionName, renderer: "xterm-pty" });
      return { sessionName: respawn.tmuxSessionName, socketName: respawn.tmuxSocketName ?? null };
    },
    {
      authorize: (request) => {
        const raw = request.headers[E2E_RUN_ID_HEADER];
        const mismatch = e2eRunIdMismatch(Array.isArray(raw) ? raw[0] : raw);
        return mismatch ? { status: 409, body: mismatch } : null;
      },
    },
  );

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

  // Status monitor / auto-recovery / auto-resume / terminal reaper: see their own modules for context.
  const statusMonitor = startDaemonStatusMonitor(store, emit, config, recentUserAction, diagnostics);
  if (statusMonitor) server.on("close", () => statusMonitor.stop());
  const autoRecoveryMonitor = startDaemonAutoRecoveryMonitor({
    store,
    config,
    operations,
    emit,
    // Skip ticks when no SSE viewer is connected (2-min grace). Auto-recovery
    // is a viewer-visible feature; consuming GitHub quota with nobody watching
    // is the largest pre-optimization quota sink.
    shouldRun: () => ghAutomationEnabled && (ghQuota.hasViewers() || ghQuota.msSinceLastViewer() <= 2 * 60_000),
    providerCache,
    scheduler: ghQuota.scheduler,
    resolveRepoFullName,
    cachedProvider,
  });
  if (autoRecoveryMonitor) server.on("close", () => autoRecoveryMonitor.stop());
  const autoResume = startDaemonAutoResumeLoop(store, operations, config);
  if (autoResume) server.on("close", () => autoResume.stop());
  const terminalReaper = startTerminalReaper({
    listSocketNames: () => {
      const sockets = new Set<string | null>([null]);
      for (const session of store.listSessions()) sockets.add(session.tmuxSocketName ?? null);
      return sockets;
    },
  });
  server.on("close", () => terminalReaper.stop());

  return { app, server, emit, diagnostics };

  function cachedProvider<T>(key: string, load: () => T | Promise<T>, ttlMs = 10_000): Promise<T> {
    return cachedProviderValue(providerCache, key, load, ttlMs);
  }
  // Stale-while-revalidate variant used by the per-workspace provider routes
  // (vc:*, ci:*, issue:*). Strict cachedProvider is preserved for provider-
  // health, git:*, apps:* — they need authoritative freshness or have their
  // own TTL semantics.
  function cachedProviderSwr<T>(key: string, load: () => T | Promise<T>, ttlMs = 10_000): Promise<T> {
    return cachedProviderWithStaleFallback({ cache: providerCache, key, load, ttlMs });
  }
}
