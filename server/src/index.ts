import cors from 'cors';
import express from 'express';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import httpProxy from 'http-proxy';
import { API_PORT, APP_NAME } from './lib/config.js';
import { collectCrons, getCronById, listCronRuns, runCronNow, setCronEnabled } from './lib/crons.js';
import { collectJobs, getJobById, resolveWorkflow, triggerWorkflowReconcile } from './lib/jobs.js';
import { setMarkedStale } from './lib/operatorFlags.js';
import { cleanupCitadelTtyds, ensureClaudeResumeSession, ensureHomeShellSession, ensureOpenClawTuiSession, ensureShellSession, ensureTerminalSession, listTerminalSessions } from './lib/tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const terminalProxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

app.use(cors());
app.use(express.json());

const JOBS_CACHE_TTL_MS = 30_000;
let jobsCache: { at: number; jobs: Awaited<ReturnType<typeof collectJobs>> } | null = null;
let jobsInflight: Promise<Awaited<ReturnType<typeof collectJobs>>> | null = null;

async function loadJobsCached() {
  const now = Date.now();
  if (jobsCache && now - jobsCache.at < JOBS_CACHE_TTL_MS) return jobsCache.jobs;
  if (jobsInflight) return jobsInflight;
  jobsInflight = collectJobs()
    .then((jobs) => {
      jobsCache = { at: Date.now(), jobs };
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
  const raw = execFileSync('openclaw', ['status', '--json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(raw) as Record<string, any>;
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
    const [jobs, crons] = await Promise.all([loadJobsCached(), Promise.resolve(collectCrons())]);
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
          jobs: jobs.length,
          crons: crons.length,
          terminals: terminalSessions.length
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'openclaw_stats_failed' });
  }
});

app.get('/api/jobs', async (_req, res) => {
  const jobs = await loadJobsCached();
  res.json({ jobs });
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const jobs = await loadJobsCached();
  const job = jobs.find((item) => item.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ job });
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

app.post('/api/jobs/:jobId/actions/mark-stale', async (req, res) => {
  const stale = Boolean(req.body?.stale);
  const flags = setMarkedStale(req.params.jobId, stale);
  invalidateJobsCache();
  res.json({ ok: true, flags });
});

app.post('/api/jobs/:jobId/actions/open-terminal', async (req, res) => {
  const job = await getJobById(req.params.jobId);
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
  const job = await getJobById(req.params.jobId);
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
  const job = await getJobById(req.params.jobId);
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

app.post('/api/jobs/:jobId/actions/recover-claude', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job || !job.tmuxSession || !job.worktreePath || !job.claudeSessionId) return res.status(404).json({ error: 'job_tmux_worktree_or_claude_session_missing' });
  try {
    const terminal = await ensureClaudeResumeSession({
      key: `job:${job.id}:claude-recover`,
      tmuxSession: job.tmuxSession,
      worktreePath: job.worktreePath,
      claudeSessionId: job.claudeSessionId,
      host: req.headers.host || '127.0.0.1'
    });
    res.json({ ok: true, terminal });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'claude_recover_failed' });
  }
});

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

server.listen(API_PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} API listening on http://0.0.0.0:${API_PORT}`);
});
