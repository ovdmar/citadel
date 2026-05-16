import cors from 'cors';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';
import { API_PORT, APP_NAME, WORKFLOWS } from './lib/config.js';
import { collectCrons, getCronById, listCronRuns, runCronNow, setCronEnabled } from './lib/crons.js';
import { listJsonFiles } from './lib/fs.js';
import { collectJobs, createManualWorkspace, fetchDevLinks, fetchGitStatusSummary, fetchPullRequestSummary, getJobById, getJobSummaryById, invalidateJobCaches, invalidateWorkflowStateCache, resolveWorkflow, runWorktreeDeploy, triggerWorkflowReconcile } from './lib/jobs.js';
import type { ManualWorkspaceCreateInput } from './lib/jobs.js';
import { setMarkedStale } from './lib/operatorFlags.js';
import { primeSlackWorkspaceUrl } from './lib/slack.js';
import { cleanupCitadelTtyds, ensureClaudeResumeSession, ensureHomeShellSession, ensureOpenClawTuiSession, ensureShellSession, ensureTerminalSession, listTerminalSessions } from './lib/tmux.js';
import { forceRefreshUsageCache, getUsageHistory, getUsageSnapshot, primeUsageCacheInBackground } from './lib/usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const terminalProxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

terminalProxy.on('error', (error, req, target) => {
  const message = error instanceof Error ? error.message : 'terminal_proxy_failed';

  if (target && typeof (target as any).writeHead === 'function') {
    const res = target as any;
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (typeof res.end === 'function') res.end(message);
    return;
  }

  if (target && typeof (target as any).destroy === 'function') {
    try {
      (target as any).destroy();
      return;
    } catch {}
  }

  console.warn(`[${APP_NAME}] terminal proxy error for ${req.url || 'unknown'}: ${message}`);
});

app.use(cors());
app.use(express.json());

const JOBS_CACHE_TTL_MS = 5 * 60_000;
const OPENCLAW_STATS_CACHE_TTL_MS = 30_000;
let jobsCache: { at: number; signature: string; jobs: Awaited<ReturnType<typeof collectJobs>> } | null = null;
let jobsInflight: Promise<Awaited<ReturnType<typeof collectJobs>>> | null = null;
let openClawStatsCache: { at: number; stats: Record<string, any> } | null = null;


function jobsCacheSignature() {
  return WORKFLOWS.map((workflow) => {
    const files = listJsonFiles(workflow.stateDir);
    const fileBits = files.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${path.basename(filePath)}:${stat.mtimeMs}`;
      } catch {
        return `${path.basename(filePath)}:missing`;
      }
    });
    return `${workflow.key}[${fileBits.join(',')}]`;
  }).join('|');
}

async function loadJobsCached() {
  const now = Date.now();
  const signature = jobsCacheSignature();
  if (jobsCache && jobsCache.signature === signature && now - jobsCache.at < JOBS_CACHE_TTL_MS) return jobsCache.jobs;
  if (jobsInflight) return jobsInflight;
  jobsInflight = collectJobs()
    .then((jobs) => {
      jobsCache = { at: Date.now(), signature, jobs };
      return jobs;
    })
    .finally(() => {
      jobsInflight = null;
    });
  return jobsInflight;
}

function invalidateJobsCache() {
  jobsCache = null;
}

function readOpenClawStatus() {
  const now = Date.now();
  if (openClawStatsCache && now - openClawStatsCache.at < OPENCLAW_STATS_CACHE_TTL_MS) return openClawStatsCache.stats;
  const raw = execFileSync('openclaw', ['status', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const stats = JSON.parse(raw) as Record<string, any>;
  openClawStatsCache = { at: now, stats };
  return stats;
}

function terminalProxyTarget(reqPath: string) {
  const match = reqPath.match(/^\/terminals\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  const key = decodeURIComponent(match[1] || '');
  const terminal = listTerminalSessions().find((entry) => entry.key === key);
  if (!terminal) return null;
  return {
    terminal,
    target: `http://127.0.0.1:${terminal.port}`,
    path: match[2] || '/'
  };
}

app.use('/terminals/:key', (req, res) => {
  const resolved = terminalProxyTarget(req.originalUrl || req.url);
  if (!resolved) return res.status(404).send('terminal_not_found');

  req.url = resolved.path;
  terminalProxy.web(req, res, { target: resolved.target }, (error: Error) => {
    if (!res.headersSent) res.status(502).send(error instanceof Error ? error.message : 'terminal_proxy_failed');
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: APP_NAME, now: new Date().toISOString() });
});

app.get('/api/openclaw/stats', async (_req, res) => {
  try {
    const crons = collectCrons();
    const jobCount = WORKFLOWS.reduce((count, workflow) => count + listJsonFiles(workflow.stateDir).length, 0);
    const status = readOpenClawStatus();
    const sessions = status.sessions || {};
    const gateway = status.gateway || {};
    const gatewayService = status.gatewayService || {};
    const tasks = status.tasks || {};
    const memory = status.memory || {};
    const agents = status.agents || {};
    const channels = Array.isArray(status.channels) ? status.channels : [];
    const terminalSessions = listTerminalSessions();

    res.json({
      ok: true,
      stats: {
        runtimeVersion: status.runtimeVersion,
        gateway: {
          url: gateway.url,
          reachable: gateway.reachable,
          latencyMs: gateway.latencyMs,
          serviceInstalled: gatewayService.installed,
          serviceLoaded: gatewayService.loaded,
          serviceRunning: gatewayService.running,
          pid: gatewayService.pid
        },
        sessions: {
          count: sessions.count || 0,
          recent: sessions.recent || [],
          defaultModel: sessions.defaults?.model,
          contextTokens: sessions.defaults?.contextTokens
        },
        agents: {
          count: agents.count || 0,
          items: agents.agents || []
        },
        memory: {
          chunkCount: memory.chunkCount || 0,
          sourceCount: memory.sourceCount || 0,
          plugin: status.memoryPlugin?.slot
        },
        tasks: {
          active: tasks.active || 0,
          total: tasks.total || 0,
          failures: tasks.failures || 0,
          queued: tasks.byStatus?.queued || 0,
          running: tasks.byStatus?.running || 0
        },
        channels: channels.map((channel: any) => ({
          label: channel.label,
          enabled: channel.enabled,
          state: channel.state,
          detail: channel.detail
        })),
        citadel: {
          jobs: jobCount,
          crons: crons.length,
          terminals: terminalSessions.length
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'openclaw_stats_failed' });
  }
});


app.get('/api/usage', (_req, res) => {
  try {
    const usage = getUsageSnapshot({ triggerBackgroundRefresh: true });
    res.json({ ok: true, usage });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'usage_snapshot_failed' });
  }
});

app.post('/api/usage/refresh', async (_req, res) => {
  try {
    const usage = await forceRefreshUsageCache();
    res.json({ ok: true, usage });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'usage_refresh_failed' });
  }
});

app.get('/api/usage/history', (_req, res) => {
  try {
    res.json({ ok: true, history: getUsageHistory() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'usage_history_failed' });
  }
});

app.get('/api/jobs', async (_req, res) => {
  const jobs = await loadJobsCached();
  res.json({ jobs });
});

app.post('/api/workspaces/create', async (req, res) => {
  try {
    const workflow = typeof req.body?.workflow === 'string' ? req.body.workflow : '';
    const startMode = typeof req.body?.startMode === 'string' ? req.body.startMode : '';
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined;
    const jiraKey = typeof req.body?.jiraKey === 'string' ? req.body.jiraKey : undefined;
    const branchName = typeof req.body?.branchName === 'string' ? req.body.branchName : undefined;
    const prRef = typeof req.body?.prRef === 'string' ? req.body.prRef : undefined;

    if (!workflow) return res.status(400).json({ error: 'workflow_required' });
    if (!['new', 'existing_branch', 'existing_pr'].includes(startMode)) return res.status(400).json({ error: 'invalid_start_mode' });
    if (startMode === 'existing_branch' && !branchName?.trim()) return res.status(400).json({ error: 'branch_name_required' });
    if (startMode === 'existing_pr' && !prRef?.trim()) return res.status(400).json({ error: 'pr_ref_required' });
    if (startMode === 'new' && !title?.trim() && !jiraKey?.trim()) return res.status(400).json({ error: 'title_or_jira_required' });

    const payload: ManualWorkspaceCreateInput = {
      workflow: workflow as ManualWorkspaceCreateInput['workflow'],
      title,
      jiraKey,
      startMode: startMode as ManualWorkspaceCreateInput['startMode'],
      branchName,
      prRef,
    };
    const created = createManualWorkspace(payload);
    invalidateWorkflowStateCache();
    invalidateJobsCache();
    const job = await getJobById(String(created.job_id));
    res.status(201).json({ ok: true, job });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'workspace_create_failed' });
  }
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ job });
});

app.get('/api/jobs/:jobId/pr', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  if (!job.prUrl) return res.json({ pr: undefined });
  const pr = fetchPullRequestSummary(job.prUrl, job.prNumber) || job.pr;
  res.json({ pr });
});

app.get('/api/jobs/:jobId/git', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ gitStatus: fetchGitStatusSummary(job.worktreePath) });
});

app.get('/api/jobs/:jobId/dev-links', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ devLinks: fetchDevLinks(job.worktreePath) });
});

app.get('/api/crons', (_req, res) => {
  try {
    const crons = collectCrons();
    res.json({ crons });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'cron_list_failed' });
  }
});

app.get('/api/crons/:cronId', (req, res) => {
  try {
    const cron = getCronById(req.params.cronId);
    if (!cron) return res.status(404).json({ error: 'cron_not_found' });
    const runs = listCronRuns(req.params.cronId, 8);
    res.json({ cron, runs });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'cron_detail_failed' });
  }
});

app.post('/api/crons/:cronId/actions/run', (req, res) => {
  try {
    const cron = getCronById(req.params.cronId);
    if (!cron) return res.status(404).json({ error: 'cron_not_found' });
    const result = runCronNow(req.params.cronId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'cron_run_failed' });
  }
});

app.post('/api/crons/:cronId/actions/set-enabled', (req, res) => {
  try {
    const cron = getCronById(req.params.cronId);
    if (!cron) return res.status(404).json({ error: 'cron_not_found' });
    const result = setCronEnabled(req.params.cronId, Boolean(req.body?.enabled));
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'cron_toggle_failed' });
  }
});

app.post('/api/jobs/:jobId/actions/reconcile', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  const workflow = resolveWorkflow(job.workflow);
  if (!workflow) return res.status(400).json({ error: 'workflow_not_found' });
  invalidateJobsCache();
  const result = triggerWorkflowReconcile(workflow);
  res.json({ ok: true, result });
});

app.post('/api/jobs/:jobId/actions/refresh-state', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  invalidateWorkflowStateCache();
  invalidateJobCaches({ prUrl: job.prUrl, worktreePath: job.worktreePath });
  invalidateJobsCache();
  const refreshed = await getJobById(req.params.jobId);
  res.json({ ok: true, job: refreshed });
});

app.post('/api/jobs/:jobId/actions/mark-stale', async (req, res) => {
  const stale = Boolean(req.body?.stale);
  const flags = setMarkedStale(req.params.jobId, stale);
  invalidateJobsCache();
  res.json({ ok: true, flags });
});

app.post('/api/jobs/:jobId/actions/refresh-pr', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  invalidateJobCaches({ prUrl: job.prUrl, worktreePath: undefined });
  invalidateJobsCache();
  const refreshed = await getJobById(req.params.jobId);
  res.json({ ok: true, job: refreshed });
});

app.post('/api/jobs/:jobId/actions/redeploy-dev', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job?.worktreePath) return res.status(404).json({ error: 'job_or_worktree_missing' });
  try {
    const result = await runWorktreeDeploy(job.worktreePath);
    invalidateJobCaches({ prUrl: job.prUrl, worktreePath: job.worktreePath });
    invalidateJobsCache();
    const refreshed = await getJobById(req.params.jobId);
    res.json({ ok: true, output: result.output, job: refreshed });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'redeploy_failed' });
  }
});

app.post('/api/jobs/:jobId/actions/open-terminal', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job || !job.tmuxSession) return res.status(404).json({ error: 'job_or_tmux_missing' });
  try {
    const terminal = await ensureTerminalSession({
      key: `job:${job.id}`,
      tmuxSession: job.tmuxSession,
      worktreePath: job.worktreePath,
      host: req.headers.host || '127.0.0.1',
      recoveryMode: false
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'terminal_open_failed' });
  }
});

app.post('/api/jobs/:jobId/actions/recovery-shell', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job || !job.tmuxSession) return res.status(404).json({ error: 'job_or_tmux_missing' });
  try {
    const terminal = await ensureTerminalSession({
      key: `job:${job.id}:recovery`,
      tmuxSession: job.tmuxSession,
      worktreePath: job.worktreePath,
      host: req.headers.host || '127.0.0.1',
      recoveryMode: true
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'recovery_shell_failed' });
  }
});

app.post('/api/jobs/:jobId/actions/open-shell', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job || !job.worktreePath) return res.status(404).json({ error: 'job_or_worktree_missing' });
  try {
    const terminal = await ensureShellSession({
      key: `job:${job.id}:shell`,
      worktreePath: job.worktreePath,
      host: req.headers.host || '127.0.0.1'
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'shell_open_failed' });
  }
});

async function recoverImplementationEngine(req: express.Request, res: express.Response) {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job || !job.tmuxSession || !job.worktreePath) return res.status(404).json({ error: 'job_tmux_or_worktree_missing' });

  if (job.engine.kind === 'claude') {
    if (!job.engine.sessionId) return res.status(404).json({ error: 'engine_session_missing' });
    try {
      const terminal = await ensureClaudeResumeSession({
        key: `job:${job.id}:engine-recover`,
        tmuxSession: job.tmuxSession,
        worktreePath: job.worktreePath,
        claudeSessionId: job.engine.sessionId,
        host: req.headers.host || '127.0.0.1'
      });
      return res.json({ ok: true, terminal });
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : 'engine_recover_failed' });
    }
  }

  return res.status(400).json({ error: `engine_recover_not_supported:${job.engine.kind}` });
}

app.post('/api/jobs/:jobId/actions/recover-engine', recoverImplementationEngine);
app.post('/api/jobs/:jobId/actions/recover-claude', recoverImplementationEngine);

app.get('/api/terminals', (_req, res) => {
  res.json({ terminals: listTerminalSessions() });
});

app.post('/api/system/openclaw-terminal', async (req, res) => {
  try {
    const terminal = await ensureOpenClawTuiSession({
      key: 'system:openclaw:tui',
      homePath: process.env.HOME || '/Users/jonsnow',
      host: req.headers.host || '127.0.0.1'
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'openclaw_tui_open_failed' });
  }
});

app.post('/api/system/home-terminal', async (req, res) => {
  try {
    const terminal = await ensureHomeShellSession({
      key: 'system:home:shell',
      homePath: process.env.HOME || '/Users/jonsnow',
      host: req.headers.host || '127.0.0.1'
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'home_shell_open_failed' });
  }
});

const webDist = path.resolve(__dirname, '../../web');
const builtWebDist = path.resolve(__dirname, '../../dist/web');
const staticRoot = path.join(builtWebDist, 'index.html');
if (path.isAbsolute(staticRoot)) {
  app.use(express.static(builtWebDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(builtWebDist, 'index.html'), (err) => {
      if (err) next();
    });
  });
}

const cleanup = cleanupCitadelTtyds();
if (cleanup.killed > 0) {
  console.log(`${APP_NAME} cleaned up ${cleanup.killed} stale ttyd process(es) on startup`);
}

server.on('upgrade', (req, socket, head) => {
  const resolved = terminalProxyTarget(req.url || '');
  if (!resolved) {
    socket.destroy();
    return;
  }
  req.url = resolved.path;
  terminalProxy.ws(req, socket, head, { target: resolved.target });
});

async function start() {
  try {
    await primeSlackWorkspaceUrl();
primeUsageCacheInBackground();
  } catch {}
  try {
    await loadJobsCached();
  } catch {}
  try {
    readOpenClawStatus();
  } catch {}

  server.listen(API_PORT, '0.0.0.0', () => {
    console.log(`${APP_NAME} API listening on http://0.0.0.0:${API_PORT}`);
  });
}

void start();
