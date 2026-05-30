import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CitadelConfig } from "@citadel/config";
import { mergeConfigPatch, saveConfig } from "@citadel/config";
import {
  type AppEvent,
  CreateWorkspaceInputSchema,
  HookActionSchema,
  type WorkspaceCockpitSummary,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { mcpStatus, mcpToolDefinitions } from "@citadel/mcp";
import { type DiagnosticsLogger, OperationService, createDiagnosticsLogger } from "@citadel/operations";
import {
  type CollectGitHubVersionControlSummaryDeps,
  collectGitHubCiRunLog,
  collectGitHubCiRuns,
  collectGitHubVersionControlSummary,
  collectJiraIssueSummary,
  collectProviderHealth,
  searchJiraIssues,
  setGithubCommand,
  setJiraCommand,
  transitionJiraIssue,
} from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import {
  attachTerminalWebSocket,
  createTtydManager,
  discoverExistingTtyds,
  ensureTmuxSession,
} from "@citadel/terminal";
import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { registerAgentSessionRoutes } from "./agent-session-routes.js";
import { asyncRoute, cachedProviderValue } from "./app-helpers.js";
import { startDaemonAutoRecoveryMonitor } from "./auto-recovery-wiring.js";
import { startDaemonAutoResumeLoop } from "./auto-resume-wiring.js";
import { getBootRestoreSummary } from "./boot-restore.js";
import { registerCitadelActionRoutes } from "./citadel-actions-routes.js";
import { callDaemonMcpTool, readMcpResource } from "./daemon-mcp-tool.js";
import { registerDiagnosticsRoutes } from "./diagnostics-routes.js";
import { registerWorkspaceExtraRoutes } from "./extra-routes.js";
import {
  AUTOMATED_GH_DISABLED_REASON,
  automatedGhEnabled,
  cachedCiOrDisabled,
  disabledVersionControlSummary,
  githubCiCacheKey,
  shouldFetchGithubCi,
} from "./gh-automation.js";
import {
  type GhQuotaWiringWithDetach,
  decorateWithCooldown,
  resolveRepoFullNameFromWorkspaces,
  wireGhQuota,
} from "./gh-quota-wiring.js";
import { wireJiraAutoTransitions } from "./jira-auto-transitions.js";
import { registerJiraRoutes } from "./jira-routes.js";
import { registerMcpRoutes } from "./mcp-routes.js";
import { registerNamespaceRoutes } from "./namespace-routes.js";
import { registerPrDiffRoute } from "./pr-diff-route.js";
import { registerPrRoutes } from "./pr-routes.js";
import { deriveReadiness, workspaceAppHookSample } from "./readiness.js";
import { registerRepoRoutes } from "./repo-routes.js";
import { registerRestoreRoutes } from "./restore-routes.js";
import { registerRuntimeUsageRoutes } from "./runtime-usage-routes.js";
import { registerScheduledAgentRoutes } from "./scheduled-agent-routes.js";
import { registerScratchpadRoutes } from "./scratchpad-routes.js";
import { backfillScratchpadOnStartup } from "./scratchpad.js";
import { startDaemonStatusMonitor } from "./status-monitor-wiring.js";
import { startTerminalReaper } from "./terminal-reaper.js";
import { wireTerminalRoutes } from "./terminal-routes-helpers.js";
import { resolveTtydPortRange } from "./ttyd-slot.js";
import { fetchVersionControlGated } from "./vc-fetch-gated.js";
import { registerWorkspaceDiffRoutes } from "./workspace-diff-routes.js";
import { readWorkspaceGitStatus } from "./workspace-diff.js";
import { bustCacheByPrefixes, createWorkspaceFsWatchers } from "./workspace-fs-watcher.js";

export type DaemonApp = {
  app: express.Express;
  server: http.Server;
  emit: (type: string, payload: unknown) => void;
  ttyd: ReturnType<typeof createTtydManager>;
  diagnostics: DiagnosticsLogger;
};

type ProviderCollectors = {
  collectGitHubVersionControlSummary: typeof collectGitHubVersionControlSummary;
  collectGitHubCiRuns: typeof collectGitHubCiRuns;
  collectGitHubCiRunLog: typeof collectGitHubCiRunLog;
  collectJiraIssueSummary: typeof collectJiraIssueSummary;
  transitionJiraIssue: typeof transitionJiraIssue;
  searchJiraIssues: typeof searchJiraIssues;
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
  const providers: ProviderCollectors = {
    collectGitHubVersionControlSummary,
    collectGitHubCiRuns,
    collectGitHubCiRunLog,
    collectJiraIssueSummary,
    transitionJiraIssue,
    searchJiraIssues,
    ...input.providers,
  };
  const app = express();
  const server = http.createServer(app);
  const sseClients = new Set<express.Response>();
  const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
  // Construct the Jira auto-transition callback ONCE so the same identity
  // reaches OperationService (for agent.started + archive/remove) and
  // registerWorkspaceExtraRoutes (for workspace.issue_attached). The
  // wireJiraAutoTransitions helper keeps boilerplate out of app.ts.
  const runAutoTransitions = wireJiraAutoTransitions({
    config,
    providers,
    store,
    emit: (type, payload) => emit(type, payload),
    providerCache,
  });
  const operations = input.operations ?? new OperationService(store, config, runAutoTransitions);
  // Always-on structured diagnostics. Writes JSONL to <dataDir>/diagnostics.jsonl
  // (rotated at 50 MB) and keeps the last 1000 events in memory for the
  // Settings → Debug panel + the /api/diagnostics/bundle.tar.gz download.
  // Sprinkled through every session-killing path so that when a user reports
  // "all my sessions died", we have the lifecycle trail to share.
  const diagnostics = createDiagnosticsLogger({ dataDir: config.dataDir });
  diagnostics.log("daemon", "createDaemonApp", {
    port: config.port,
    dataDir: config.dataDir,
    worktree: process.env.CITADEL_WORKTREE === "1",
    pid: process.pid,
    nodeVersion: process.versions.node,
  });
  const ttyd = createTtydManager({ ...resolveTtydPortRange(config.port), diagnostics });
  // Release the ttyd on every stopAgentSession path; guarded for test stubs.
  if (typeof operations.setTerminalHooks === "function") {
    operations.setTerminalHooks({ onSessionStopped: (sessionId) => ttyd.release(sessionId, "session-stopped-hook") });
  }

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
  // Boot-time discover-and-adopt: ttyds are spawned detached and the systemd
  // unit runs with KillMode=process, so they outlive daemon restarts. Scan
  // the host for survivors from the previous incarnation and adopt them back
  // into the manager — same key, same PID, no respawn. The browser's
  // WebSocket auto-reconnect (xterm `reconnect=3`) lands on the *same* ttyd
  // it was talking to before the restart.
  //
  // Discovery is scoped to this daemon's port slot before adopt() routes by
  // DB membership. That port filter is a hard safety boundary: sandbox
  // daemons can carry prod-looking DB rows, but they must not see or SIGTERM
  // the installed daemon's ttyds.
  //
  // Skipped under vitest: tests that boot a daemon would otherwise re-attach
  // to the live cockpit's ttyds and the next test that calls release() would
  // kill them.
  if (!process.env.VITEST) {
    const survivors = discoverExistingTtyds({
      basePathPrefix: ttyd.config.basePathPrefix,
      portBase: ttyd.config.portBase,
      portMax: ttyd.config.portMax,
    });
    const sessionTabIds = new Map<string, string>();
    for (const session of store.listSessions()) {
      sessionTabIds.set(session.id, session.tabId ?? session.id);
    }
    const resolveTabId = (key: string): string | null => sessionTabIds.get(key) ?? null;
    const { adopted, reapedDuplicates, reapedUnknown } = ttyd.adopt(survivors, resolveTabId);
    if (adopted > 0 || reapedDuplicates > 0 || reapedUnknown > 0) {
      emit("terminal.adopted", {
        adopted,
        reapedDuplicates,
        reapedUnknown,
        portRange: [ttyd.config.portBase, ttyd.config.portMax],
      });
    }
  }
  const { recentUserAction } = wireTerminalRoutes({
    app,
    server,
    store,
    ttyd,
    dataDir: config.dataDir,
    emit,
    config,
    diagnostics,
  });

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

  registerDiagnosticsRoutes({ app, store, ttyd, diagnostics, config });

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

  registerRepoRoutes({ app, asyncRoute, config, store, operations, providerCache, emit });

  app.get("/api/workspaces", (_req, res) => {
    res.json({ workspaces: store.listWorkspaces() });
  });

  app.get(
    "/api/workspaces/:workspaceId/cockpit-summary",
    asyncRoute(async (req, res) => {
      const workspaceId = req.params.workspaceId;
      if (typeof workspaceId !== "string") return res.status(400).json({ error: "workspace_id_required" });
      const summary = await buildWorkspaceCockpitSummary(workspaceId);
      if (!summary) return res.status(404).json({ error: "workspace_not_found" });
      res.json(summary);
    }),
  );

  // Build a full workspace cockpit summary. Shared between the single-workspace
  // endpoint and the batch endpoint registered by registerPrRoutes — the batch
  // endpoint fan-outs with a concurrency cap so 20+ workspaces don't spawn
  // 20+ concurrent `gh` subprocesses every 30s. The issue-summary route lives
  // in jira-routes.ts (extracted with the picker work).
  async function buildWorkspaceCockpitSummary(workspaceId: string): Promise<WorkspaceCockpitSummary | null> {
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId);
    if (!workspace) return null;
    const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
    if (!repo) return null;
    const ciKey = githubCiCacheKey(
      workspace,
      repo,
      resolveRepoFullName(repo.id),
      store.getWorkspacePrSnapshot(workspace.id),
    );
    const shouldFetchCi = ghAutomationEnabled && shouldFetchGithubCi(store, workspace);
    const [git, versionControlRaw, ci, issueTracker, apps] = await Promise.all([
      cachedProvider(`git:${workspace.id}:${workspace.updatedAt}`, () => readWorkspaceGitStatus(workspace.path), 3000),
      ghAutomationEnabled
        ? fetchVersionControlGated(gatedVcDeps, workspace, repo, `vc:${workspace.id}:${workspace.updatedAt}`)
        : Promise.resolve(disabledVersionControlSummary(workspace, repo)),
      shouldFetchCi
        ? cachedProvider(ciKey, () => providers.collectGitHubCiRuns(workspace.path), 60_000)
        : Promise.resolve(
            cachedCiOrDisabled(
              providerCache,
              ciKey,
              ghAutomationEnabled
                ? "GitHub CI is cached until the PR receives a new local commit"
                : AUTOMATED_GH_DISABLED_REASON,
            ),
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
    const versionControl = decorateWithCooldown(versionControlRaw);
    return {
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
  }

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

  registerJiraRoutes({ app, asyncRoute, store, providers, providerCache, emit, cachedProvider });

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

  registerAgentSessionRoutes(app, { operations, emit, asyncRoute, config, ttyd });
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

  registerWorkspaceExtraRoutes({ app, store, emit, asyncRoute, operations, runAutoTransitions, config });
  registerNamespaceRoutes({ app, store, operations, emit, asyncRoute });
  registerScratchpadRoutes({ app, config, emit, store, operations, providerHealth: cachedProviderHealth });
  registerCitadelActionRoutes({ app, config, emit });
  backfillScratchpadOnStartup(config);

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
  const terminalReaper = startTerminalReaper();
  server.on("close", () => terminalReaper.stop());

  return { app, server, emit, ttyd, diagnostics };

  function cachedProvider<T>(key: string, load: () => T | Promise<T>, ttlMs = 10_000): Promise<T> {
    return cachedProviderValue(providerCache, key, load, ttlMs);
  }
}
