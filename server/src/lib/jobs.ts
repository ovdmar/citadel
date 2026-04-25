import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { JOB_STALE_MINUTES, WORKFLOWS } from './config.js';
import { listJsonFiles, readJsonFile } from './fs.js';
import { getOperatorFlags } from './operatorFlags.js';
import { fetchSlackThreadSummary } from './slack.js';
import { captureTmuxTail, listTmuxSessions } from './tmux.js';
import { minutesSince, trimExcerpt } from './util.js';
import type { JobRecord, JobState, WorkflowConfig } from '../types.js';

function mapState(raw: Record<string, unknown>, tmuxExists: boolean, operatorMarkedStale: boolean, lastActivityAt?: string): { state: JobState; reason: string; detail?: string } {
  const tail = String(raw.last_tmux_tail_excerpt || '').toLowerCase();
  const lastError = typeof raw.last_error === 'string' ? raw.last_error : undefined;
  const lastSentAction = typeof raw.last_sent_action === 'string' ? raw.last_sent_action : undefined;
  const lastInboundReply = typeof raw.last_inbound_reply === 'string' ? raw.last_inbound_reply : undefined;
  const approvalMode = typeof raw.approval_mode_effective === 'string' ? raw.approval_mode_effective : undefined;

  if (!tmuxExists) return { state: 'broken_missing_tmux', reason: 'tmux_session_missing' };
  if (operatorMarkedStale) return { state: 'stale', reason: 'operator_marked_stale' };
  if (lastError) return { state: 'failed', reason: 'last_error_present', detail: lastError };
  if (lastSentAction === 'post_ready_for_review' || tail.includes('ready for review') || tail.includes('ready for qa')) {
    return { state: 'waiting_review', reason: 'ready_for_review_signals' };
  }
  if (approvalMode === 'manual' && (tail.includes('ready for your approval') || tail.includes('ready for approval') || tail.includes('waiting for approval'))) {
    return { state: 'waiting_approval', reason: 'approval_gate_signals' };
  }
  if (tail.includes('waiting for your input') || tail.includes('would you prefer') || tail.includes('please confirm') || tail.includes('what do you think')) {
    return { state: 'waiting_human', reason: 'human_input_signals', detail: lastInboundReply };
  }
  if (lastActivityAt && minutesSince(lastActivityAt) > JOB_STALE_MINUTES) {
    return { state: 'stale', reason: 'no_recent_activity' };
  }
  return { state: 'running', reason: 'active_state_present', detail: lastInboundReply };
}

function getLastActivityAt(raw: Record<string, unknown>) {
  const candidates = [
    raw.updated_at,
    raw.last_thread_activity_at,
    raw.last_tmux_tail_changed_at,
    raw.last_tmux_tail_seen_at,
    raw.last_sent_at,
    raw.last_inbound_reply_at,
    raw.created_at
  ].filter((value): value is string => typeof value === 'string');
  return candidates.sort().at(-1);
}

function summarizeTitle(workflow: WorkflowConfig, raw: Record<string, unknown>) {
  return (raw.jira_summary as string | undefined)
    || (raw.slug as string | undefined)
    || (raw.jira_key as string | undefined)
    || `${workflow.label} job`;
}

function getPath(raw: Record<string, unknown>, key: string) {
  const value = raw[key];
  return typeof value === 'string' ? value : undefined;
}

export async function collectJobs(): Promise<JobRecord[]> {
  const tmuxSessions = new Set(listTmuxSessions());
  const jobs = await Promise.all(
    WORKFLOWS.flatMap((workflow) =>
      listJsonFiles(workflow.stateDir).map(async (jobPath) => {
        const raw = readJsonFile<Record<string, unknown>>(jobPath);
        if (!raw) return null;

        const tmuxSession = getPath(raw, 'tmux_session');
        const tmuxExists = tmuxSession ? tmuxSessions.has(tmuxSession) : false;
        const operatorFlags = getOperatorFlags(String(raw.job_id || raw.run_id || jobPath));
        const slackThreadTs = getPath(raw, 'slack_thread_ts');
        const slack = await fetchSlackThreadSummary(workflow.channelId, slackThreadTs);
        const lastActivityAt = getLastActivityAt(raw);
        const liveTail = tmuxExists && tmuxSession ? captureTmuxTail(tmuxSession, 80) : '';
        const lastTmuxTailExcerpt = trimExcerpt(liveTail || (raw.last_tmux_tail_excerpt as string | undefined));
        if (lastTmuxTailExcerpt) raw.last_tmux_tail_excerpt = lastTmuxTailExcerpt;
        const mapped = mapState(raw, tmuxExists, Boolean(operatorFlags.markedStaleAt), lastActivityAt);

        return {
          id: String(raw.job_id || raw.run_id || jobPath),
          workflow: workflow.key,
          workflowLabel: workflow.label,
          channelId: workflow.channelId,
          jiraKey: raw.jira_key as string | undefined,
          title: summarizeTitle(workflow, raw),
          jiraUrl: raw.jira_url as string | undefined,
          prUrl: raw.pr_url as string | undefined,
          prNumber: typeof raw.pr_number === 'number' ? raw.pr_number : undefined,
          slackThreadTs,
          slack,
          tmuxSession,
          tmuxExists,
          tmuxWindow: tmuxSession,
          worktreePath: getPath(raw, 'worktree_path'),
          transcriptPath: getPath(raw, 'transcript_path'),
          claudeSessionId: getPath(raw, 'claude_session_id') || (getPath(raw, 'transcript_path')?.split('/').pop()?.replace(/\.jsonl$/, '')),
          planPath: getPath(raw, 'plan_path'),
          requestPath: getPath(raw, 'request_path'),
          branchName: getPath(raw, 'branch_name'),
          createdAt: getPath(raw, 'created_at'),
          updatedAt: getPath(raw, 'updated_at'),
          lastActivityAt,
          lastTmuxTailExcerpt,
          state: mapped.state,
          stateReason: mapped.reason,
          stateSource: 'citadel-fast-path',
          statusDetail: mapped.detail,
          operatorFlags,
          actions: {
            canReconcile: true,
            canCreateRecoveryShell: !tmuxExists && Boolean(tmuxSession),
            canOpenTerminal: Boolean(tmuxSession)
          },
          raw
        } satisfies JobRecord;
      })
    )
  );

  return jobs
    .filter(Boolean)
    .map((job) => job as JobRecord)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getJobById(jobId: string) {
  const jobs = await collectJobs();
  return jobs.find((job) => job.id === jobId);
}

export function triggerWorkflowReconcile(workflow: WorkflowConfig) {
  const child = spawn(workflow.reconcileCommand[0], workflow.reconcileCommand.slice(1), {
    stdio: 'ignore',
    detached: false
  });
  return { pid: child.pid ?? -1, command: workflow.reconcileCommand };
}

export function resolveWorkflow(key: string) {
  return WORKFLOWS.find((workflow) => workflow.key === key);
}
