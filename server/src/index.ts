import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PORT, APP_NAME } from './lib/config.js';
import { collectJobs, getJobById, resolveWorkflow, triggerWorkflowReconcile } from './lib/jobs.js';
import { setMarkedStale } from './lib/operatorFlags.js';
import { ensureTerminalSession, listTerminalSessions } from './lib/tmux.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: APP_NAME, now: new Date().toISOString() });
});

app.get('/api/jobs', async (_req, res) => {
  const jobs = await collectJobs();
  res.json({ jobs });
});

app.get('/api/jobs/:jobId', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  res.json({ job });
});

app.post('/api/jobs/:jobId/actions/reconcile', async (req, res) => {
  const job = await getJobById(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job_not_found' });
  const workflow = resolveWorkflow(job.workflow);
  if (!workflow) return res.status(400).json({ error: 'workflow_not_found' });
  const result = triggerWorkflowReconcile(workflow);
  res.json({ ok: true, result });
});

app.post('/api/jobs/:jobId/actions/mark-stale', async (req, res) => {
  const stale = Boolean(req.body?.stale);
  const flags = setMarkedStale(req.params.jobId, stale);
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

app.get('/api/terminals', (_req, res) => {
  res.json({ terminals: listTerminalSessions() });
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

app.listen(API_PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} API listening on http://0.0.0.0:${API_PORT}`);
});
