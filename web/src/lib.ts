import type { CronRecord, CronRunEntry, JobRecord, OpenClawStats, TerminalRecord } from './types';

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

export async function loadJobs() {
  return api<{ jobs: JobRecord[] }>('/api/jobs');
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

export async function markJobStale(jobId: string, stale: boolean) {
  return api(`/api/jobs/${jobId}/actions/mark-stale`, {
    method: 'POST',
    body: JSON.stringify({ stale })
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
