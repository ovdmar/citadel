import { execFileSync } from 'node:child_process';
import type { CronJobRecord, CronRunEntry } from '../types.js';

function runOpenClaw(args: string[]) {
  return execFileSync('openclaw', ['cron', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  }).trim();
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function scheduleLabel(job: CronJobRecord) {
  const schedule = job.schedule || {};
  if (schedule.kind === 'every' && typeof schedule.everyMs === 'number') {
    const minutes = Math.round(schedule.everyMs / 60000);
    if (minutes < 60) return `Every ${minutes}m`;
    const hours = Math.round(minutes / 60);
    return `Every ${hours}h`;
  }
  if (schedule.kind === 'cron') {
    return schedule.tz ? `${schedule.expr} @ ${schedule.tz}` : (schedule.expr || 'cron');
  }
  if (schedule.kind === 'at') {
    return schedule.at || 'One-shot';
  }
  return schedule.kind || 'Unknown';
}

function classifyHealth(job: CronJobRecord): CronJobRecord['health'] {
  if (!job.enabled) return 'disabled';
  const state = job.state || {};
  if ((state.consecutiveErrors || 0) > 0) return 'failing';
  if (state.lastStatus && state.lastStatus !== 'ok') return 'failing';
  if (job.schedule?.kind === 'at' && (state.lastStatus === 'ok' || state.lastRunStatus === 'ok')) return 'completed';
  if (job.schedule?.kind === 'at') return 'pending';
  return 'healthy';
}

function enrich(job: CronJobRecord): CronJobRecord {
  const state = job.state || {};
  return {
    ...job,
    scheduleLabel: scheduleLabel(job),
    health: classifyHealth(job),
    nextRunAt: state.nextRunAtMs ? new Date(state.nextRunAtMs).toISOString() : undefined,
    lastRunAt: state.lastRunAtMs ? new Date(state.lastRunAtMs).toISOString() : undefined
  };
}

export function collectCrons(): CronJobRecord[] {
  const output = runOpenClaw(['list', '--all', '--json']);
  const parsed = parseJson<{ jobs: CronJobRecord[] }>(output);
  return (parsed.jobs || []).map(enrich);
}

export function getCronById(id: string) {
  return collectCrons().find((job) => job.id === id);
}

export function listCronRuns(id: string, limit = 8): CronRunEntry[] {
  const output = runOpenClaw(['runs', '--id', id, '--limit', String(limit)]);
  const parsed = parseJson<{ entries: CronRunEntry[] }>(output);
  return parsed.entries || [];
}

export function runCronNow(id: string) {
  const output = runOpenClaw(['run', id]);
  return { ok: true, output };
}

export function setCronEnabled(id: string, enabled: boolean) {
  const output = runOpenClaw([enabled ? 'enable' : 'disable', id]);
  return { ok: true, output };
}
