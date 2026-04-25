import type { JobRecord, TerminalRecord } from './types';

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
  return api<{ ok: true; terminal: TerminalRecord }>(`/api/jobs/${jobId}/actions/${recovery ? 'recovery-shell' : 'open-terminal'}`, {
    method: 'POST',
    body: JSON.stringify({})
  });
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
  return api<{ terminals: TerminalRecord[] }>('/api/terminals');
}
