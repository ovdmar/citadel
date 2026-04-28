import type { JobState } from '../types';

const LABELS: Record<JobState, string> = {
  running: 'Live',
  waiting_human: 'Need you',
  waiting_review: 'Review',
  waiting_approval: 'Approve',
  conflicts: 'Conflicts',
  ci_failed: 'CI failed',
  idle: 'Idle',
  stale: 'Stale',
  broken_missing_tmux: 'Broken',
  failed: 'Failed',
  done: 'Done',
  unknown: 'Unknown'
};

export function StateBadge({ state }: { state: JobState }) {
  return <span className={`state-pill state-pill-${state}`}>{LABELS[state]}</span>;
}
