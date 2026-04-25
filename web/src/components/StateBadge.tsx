import type { JobState } from '../types';

const LABELS: Record<JobState, string> = {
  running: 'running',
  waiting_human: 'waiting human',
  waiting_review: 'waiting review',
  waiting_approval: 'waiting approval',
  idle: 'idle',
  stale: 'stale',
  broken_missing_tmux: 'broken',
  failed: 'failed',
  done: 'done',
  unknown: 'unknown'
};

export function StateBadge({ state }: { state: JobState }) {
  return <span className={`badge badge-${state}`}>{LABELS[state]}</span>;
}
