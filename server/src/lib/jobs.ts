import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { JOB_STALE_MINUTES, WORKFLOWS } from './config.js';
import { listJsonFiles, readJsonFile } from './fs.js';
import { getOperatorFlags } from './operatorFlags.js';
import { fetchSlackThreadSummary } from './slack.js';
import { captureTmuxTail, listTmuxSessions } from './tmux.js';
import { classifyWorkflowJob } from './classifiers.js';
import { minutesSince, trimExcerpt } from './util.js';
import type { JobRecord, JobState, WorkflowConfig } from '../types.js';

function mapState(rawState: string | undefined, rawReason: string | undefined, tmuxExists: boolean, operatorMarkedStale: boolean): { state: JobState; reason: string } {
  if (!tmuxExists) return { state: 'broken_missing_tmux', reason: 'tmux_session_missing' };
  if (operatorMarkedStale) return { state: 'stale', reason: 'operator_marked_stale' };
  switch (rawState) {
    case 'finished':
    case 'ready_for_review':
      return { state: 'waiting_review', reason: rawReason || rawState };
    case 'waiting_for_approval':
      return { state: 'waiting_approval', reason: rawReason || rawState };
    case 'waiting_for_human':
    case 'needs_human_input':
      return { state: 'waiting_human', reason: rawReason || rawState };
    case 'running':
    case 'planning':
    case 'reviewing':
    case 'running_in_grace':
      return { state: minutesSince(undefined) > 0 ? 'running' : 'running', reason: rawReason || rawState || 'running' };
    case 'failed':
    case 'stopped_unexpectedly':
    case 'stuck':
      return { state: rawState === 'stuck' ? 'stale' : 'failed', reason: rawReason || rawState };
    case 'done':
      return { state: 'done', reason: rawReason || rawState };
    default:
      return { state: 'unknown', reason: rawReason || rawState || 'unknown' };
  }
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
        const computed = classifyWorkflowJob(workflow, jobPath) as Record<string, unknown>;
        const mapped = mapState(computed.state as string | undefined, computed.reason as string | undefined, tmuxExists, Boolean(operatorFlags.markedStaleAt));
        const slackThreadTs = getPath(raw, 'slack_thread_ts');
        const slack = await fetchSlackThreadSummary(workflow.channelId, slackThreadTs);
        const lastActivityAt = getLastActivityAt(raw);
        const staleByInactivity = mapped.state === 'running' && minutesSince(lastActivityAt) > JOB_STALE_MINUTES;
        const finalState = staleByInactivity ? 'stale' : mapped.state;
        const finalReason = staleByInactivity ? 'no_recent_activity' : mapped.reason;
        const liveTail = tmuxExists && tmuxSession ? captureTmuxTail(tmuxSession, 80) : '';
        const lastTmuxTailExcerpt = trimExcerpt(liveTail || (raw.last_tmux_tail_excerpt as string | undefined));

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
          planPath: getPath(raw, 'plan_path'),
          requestPath: getPath(raw, 'request_path'),
          branchName: getPath(raw, 'branch_name'),
          createdAt: getPath(raw, 'created_at'),
          updatedAt: getPath(raw, 'updated_at'),
          lastActivityAt,
          lastTmuxTailExcerpt,
          state: finalState,
          stateReason: finalReason,
          stateSource: workflow.classifyMode,
          statusDetail: typeof computed.question === 'string' ? computed.question : undefined,
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
