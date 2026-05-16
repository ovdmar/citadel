import type { JobRecord } from '../types';

function conciseStatusDetail(detail?: string) {
  if (!detail) return undefined;
  const normalized = detail.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  if (detail.includes('\n')) return undefined;
  if (normalized.length > 160) return undefined;
  return normalized;
}

export function priorityScore(job: JobRecord) {
  switch (job.state) {
    case 'waiting_human':
      return 100;
    case 'conflicts':
      return 95;
    case 'ci_failed':
      return 85;
    case 'broken_missing_tmux':
    case 'failed':
      return 90;
    case 'waiting_review':
      return 80;
    case 'waiting_approval':
      return 75;
    case 'stale':
      return 65;
    case 'running':
      return 40;
    default:
      return 10;
  }
}

export function nextActionLabel(job: JobRecord) {
  switch (job.state) {
    case 'waiting_human':
      return 'Reply or jump into terminal';
    case 'conflicts':
      return 'Recover agent, resolve conflicts, rerun CI';
    case 'ci_failed':
      return 'Inspect failing checks and send the agent back in';
    case 'broken_missing_tmux':
      return 'Recover session or inspect state';
    case 'failed':
      return 'Inspect failure and reconcile';
    case 'waiting_review':
      return 'Review output and decide';
    case 'waiting_approval':
      return 'Approve or redirect';
    case 'stale':
      return 'Check if stuck or just quiet';
    case 'running':
      return 'Monitor only';
    default:
      return 'Inspect details';
  }
}

export function topSignal(job: JobRecord) {
  const detail = conciseStatusDetail(job.statusDetail);
  if (detail) return detail;
  switch (job.state) {
    case 'waiting_human':
      return 'The agent is waiting for input from you.';
    case 'conflicts':
      return 'PR is in merge-conflict state. Reconciler should push the agent to rebase, resolve conflicts, and get CI green again.';
    case 'ci_failed':
      return 'The agent appears done, but the PR checks are failing. This should go back into the fix-and-rerun loop, not to human review yet.';
    case 'broken_missing_tmux':
      return 'State says active, but the tmux session is missing.';
    case 'failed':
      return 'This job likely needs intervention.';
    case 'waiting_review':
      return 'Output is ready for review.';
    case 'waiting_approval':
      return 'Plan is ready for approval.';
    case 'stale':
      return 'No recent activity, verify whether it is actually stuck.';
    case 'running':
      return 'Job looks active, no intervention needed yet.';
    default:
      return job.stateReason;
  }
}
