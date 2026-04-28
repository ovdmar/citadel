import type { CronRecord, CronRunEntry, JobRecord, OpenClawStats, TerminalRecord, UsageHistoryPoint, UsageSnapshot, UsageWindow } from './types';

function terminalProxyUrl(terminal: TerminalRecord) {
  return `/terminals/${encodeURIComponent(terminal.key)}/`;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'request_failed');
  }
  return data;
}

export function formatTime(input?: string) {
  if (!input) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(input));
}

export function formatFriendlyDateTime(input?: string) {
  if (!input) return '—';
  const date = new Date(input);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow = date.toDateString() === tomorrow.toDateString();
  const options: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  if (sameDay) return `Today at ${new Intl.DateTimeFormat(undefined, options).format(date)}`;
  if (isTomorrow) return `Tomorrow at ${new Intl.DateTimeFormat(undefined, options).format(date)}`;
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(date).replace(',', ' at');
}

export function relativeTime(input?: string) {
  if (!input) return '—';
  const diffMinutes = Math.round((Date.now() - new Date(input).getTime()) / 60000);
  if (Math.abs(diffMinutes) < 1) return 'now';
  if (Math.abs(diffMinutes) < 60) return `${diffMinutes}m ago`;
  const hours = Math.round(diffMinutes / 60);
  if (Math.abs(hours) < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

export function usageWindowWillLastUntilReset(window?: UsageWindow) {
  if (typeof window?.lastsUntilReset === 'boolean') return window.lastsUntilReset;
  if (!window?.resetsAt || typeof window.windowMinutes !== 'number' || typeof window.remainingPercent !== 'number') return undefined;
  const resetAtMs = new Date(window.resetsAt).getTime();
  if (!Number.isFinite(resetAtMs)) return undefined;
  const windowMs = window.windowMinutes * 60_000;
  if (windowMs <= 0) return undefined;
  const startAtMs = resetAtMs - windowMs;
  const elapsedFraction = Math.max(0, Math.min(1, (Date.now() - startAtMs) / windowMs));
  const expectedRemainingPercent = (1 - elapsedFraction) * 100;
  return window.remainingPercent >= expectedRemainingPercent;
}

export function usageWindowTone(window?: UsageWindow): 'neutral' | 'ok' | 'danger' {
  const willLast = usageWindowWillLastUntilReset(window);
  if (willLast === undefined) return 'neutral';
  return willLast ? 'ok' : 'danger';
}

export async function loadJobs() {
  return api<{ jobs: JobRecord[] }>('/api/jobs');
}

export async function createWorkspace(input: {
  workflow: JobRecord['workflow'];
  title?: string;
  jiraKey?: string;
  startMode: NonNullable<JobRecord['startMode']>;
  branchName?: string;
  prRef?: string;
}) {
  return api<{ ok: true; job?: JobRecord }>('/api/workspaces/create', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function loadJobDetail(jobId: string) {
  return api<{ job: JobRecord }>(`/api/jobs/${jobId}`);
}

export async function loadJobPr(jobId: string) {
  return api<{ pr?: JobRecord['pr'] }>(`/api/jobs/${jobId}/pr`);
}

export async function loadJobGit(jobId: string) {
  return api<{ gitStatus?: JobRecord['gitStatus'] }>(`/api/jobs/${jobId}/git`);
}

export async function loadJobDevLinks(jobId: string) {
  return api<{ devLinks?: JobRecord['devLinks'] }>(`/api/jobs/${jobId}/dev-links`);
}

export async function openTerminal(jobId: string, recovery = false) {
  const response = await api<{ ok: true; terminal: TerminalRecord }>(`/api/jobs/${jobId}/actions/${recovery ? 'recovery-shell' : 'open-terminal'}`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  return { ...response, terminal: { ...response.terminal, url: terminalProxyUrl(response.terminal) } };
}

export async function recoverClaude(jobId: string) {
  const response = await api<{ ok: true; terminal: TerminalRecord }>(`/api/jobs/${jobId}/actions/recover-claude`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  return { ...response, terminal: { ...response.terminal, url: terminalProxyUrl(response.terminal) } };
}

export async function openShell(jobId: string) {
  const response = await api<{ ok: true; terminal: TerminalRecord }>(`/api/jobs/${jobId}/actions/open-shell`, {
    method: 'POST',
    body: JSON.stringify({})
  });
  return { ...response, terminal: { ...response.terminal, url: terminalProxyUrl(response.terminal) } };
}

export async function reconcileJob(jobId: string) {
  return api(`/api/jobs/${jobId}/actions/reconcile`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function refreshJobState(jobId: string) {
  return api<{ ok: true; job?: JobRecord }>(`/api/jobs/${jobId}/actions/refresh-state`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function markJobStale(jobId: string, stale: boolean) {
  return api(`/api/jobs/${jobId}/actions/mark-stale`, {
    method: 'POST',
    body: JSON.stringify({ stale })
  });
}

export async function refreshJobPr(jobId: string) {
  return api(`/api/jobs/${jobId}/actions/refresh-pr`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function redeployJobDev(jobId: string) {
  return api(`/api/jobs/${jobId}/actions/redeploy-dev`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function loadTerminals() {
  const response = await api<{ terminals: TerminalRecord[] }>('/api/terminals');
  return { terminals: response.terminals.map((terminal) => ({ ...terminal, url: terminalProxyUrl(terminal) })) };
}

export async function loadCrons() {
  return api<{ crons: CronRecord[] }>('/api/crons');
}

export async function loadCronDetail(cronId: string) {
  return api<{ cron: CronRecord; runs: CronRunEntry[] }>(`/api/crons/${cronId}`);
}

export async function runCron(cronId: string) {
  return api<{ ok: true; output?: string }>(`/api/crons/${cronId}/actions/run`, {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function setCronEnabled(cronId: string, enabled: boolean) {
  return api<{ ok: true; output?: string }>(`/api/crons/${cronId}/actions/set-enabled`, {
    method: 'POST',
    body: JSON.stringify({ enabled })
  });
}


export async function openHomeTerminal() {
  const response = await api<{ ok: true; terminal: TerminalRecord }>('/api/system/home-terminal', {
    method: 'POST',
    body: JSON.stringify({})
  });
  return { ...response, terminal: { ...response.terminal, url: terminalProxyUrl(response.terminal) } };
}

export async function openOpenClawTerminal() {
  const response = await api<{ ok: true; terminal: TerminalRecord }>('/api/system/openclaw-terminal', {
    method: 'POST',
    body: JSON.stringify({})
  });
  return { ...response, terminal: { ...response.terminal, url: terminalProxyUrl(response.terminal) } };
}

export async function loadOpenClawStats() {
  return api<{ ok: true; stats: OpenClawStats }>('/api/openclaw/stats');
}


export async function loadUsageSnapshot() {
  return api<{ ok: true; usage: UsageSnapshot }>('/api/usage');
}

export async function forceRefreshUsageSnapshot() {
  return api<{ ok: true; usage: UsageSnapshot }>('/api/usage/refresh', {
    method: 'POST',
    body: JSON.stringify({})
  });
}

export async function loadUsageHistory() {
  return api<{ ok: true; history: UsageHistoryPoint[] }>('/api/usage/history');
}

