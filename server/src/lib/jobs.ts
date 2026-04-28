import { execFileSync, spawn } from 'node:child_process';
import { JOB_STALE_MINUTES, OPENCLAW_ROOT, WORKFLOWS } from './config.js';
import { listJsonFiles, readJsonFile } from './fs.js';
import { getOperatorFlags } from './operatorFlags.js';
import { buildSlackPermalink } from './slack.js';
import { captureTmuxTail, listTmuxSessions } from './tmux.js';
import { minutesSince, trimExcerpt } from './util.js';
import type { DevLink, GitStatusSummary, JobRecord, JobState, PullRequestSummary, WorkflowConfig } from '../types.js';

const prCache = new Map<string, { expiresAt: number; value?: PullRequestSummary }>();
const gitStatusCache = new Map<string, { expiresAt: number; value?: GitStatusSummary }>();
const devLinksCache = new Map<string, { expiresAt: number; value?: DevLink[] }>();
const workflowStateCache = new Map<string, { expiresAt: number; value?: WorkflowClassification }>();
const PR_CACHE_MS = 5 * 60_000;
const GIT_STATUS_CACHE_MS = 8_000;
const DEV_LINKS_CACHE_MS = 60_000;
const WORKFLOW_STATE_CACHE_MS = 5_000;
const SYSTEM_PATH = `${process.env.PATH || ''}:/usr/sbin:/sbin`;

export type ManualWorkspaceCreateInput = {
  workflow: WorkflowConfig['key'];
  title?: string;
  jiraKey?: string;
  startMode: 'new' | 'existing_branch' | 'existing_pr';
  branchName?: string;
  prRef?: string;
};

type WorkflowClassification = {
  state?: string;
  reason?: string;
  detail?: string;
  question?: string;
  payload?: Record<string, unknown> | null;
  tail?: string;
  review_state?: Record<string, unknown>;
  pr?: {
    pr_exists?: boolean;
    pr_number?: number;
    pr_url?: string;
    checks_status?: string;
    has_conflicts?: boolean;
  };
};

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

function getCachedWorkflowClassification(workflow: WorkflowConfig, jobPath: string) {
  return cachedValue(workflowStateCache, `${workflow.key}:${jobPath}`);
}

function setWorkflowClassificationCache(workflow: WorkflowConfig, jobPath: string, value: WorkflowClassification | undefined) {
  return setCachedValue(workflowStateCache, `${workflow.key}:${jobPath}`, value, WORKFLOW_STATE_CACHE_MS);
}

function runWorkflowClassifiers(workflow: WorkflowConfig, jobPaths: string[]): Map<string, WorkflowClassification | undefined> {
  const results = new Map<string, WorkflowClassification | undefined>();
  const uncached = jobPaths.filter((jobPath) => {
    const cached = getCachedWorkflowClassification(workflow, jobPath);
    if (cached !== undefined) {
      results.set(jobPath, cached);
      return false;
    }
    return true;
  });

  if (uncached.length === 0) return results;

  try {
    let output = '';

    if (workflow.classifyMode === 'implementation' || workflow.classifyMode === 'concept-lab') {
      const scriptDir = workflow.classifyMode === 'implementation'
        ? `${OPENCLAW_ROOT}/workspace-implementation/automation/implementation-jira/scripts`
        : `${OPENCLAW_ROOT}/workspace-concept-lab/automation/concept-lab/scripts`;
      output = execFileSync('python3', ['-c', [
        'import json, os, sys',
        'from pathlib import Path',
        `script_dir = Path(${JSON.stringify(scriptDir)})`,
        'os.chdir(script_dir)',
        'sys.path.insert(0, str(script_dir))',
        'import workflow_state',
        'results = {}',
        'for raw_path in sys.argv[1:]:',
        '    job_path = Path(raw_path)',
        '    try:',
        '        job = json.loads(job_path.read_text())',
        '        results[str(job_path)] = workflow_state.compute_state(job)',
        '    except Exception:',
        '        results[str(job_path)] = None',
        'print(json.dumps(results))'
      ].join('\n'), ...uncached], { encoding: 'utf8', timeout: workflow.classifyMode === 'implementation' ? 15000 : 6000, stdio: ['ignore', 'pipe', 'ignore'] });
    } else if (workflow.classifyMode === 'tech-plan') {
      const aggregated: Record<string, WorkflowClassification | undefined> = {};
      for (const jobPath of uncached) {
        try {
          const itemOutput = execFileSync('python3', [`${OPENCLAW_ROOT}/workspace-tech-plan/automation/tech-plan-jira/scripts/classify-job.py`, jobPath], {
            encoding: 'utf8',
            timeout: 1200,
            stdio: ['ignore', 'pipe', 'ignore']
          });
          aggregated[jobPath] = itemOutput.trim() ? JSON.parse(itemOutput) as WorkflowClassification : undefined;
        } catch {
          aggregated[jobPath] = undefined;
        }
      }
      output = JSON.stringify(aggregated);
    }

    const parsed = output.trim() ? JSON.parse(output) as Record<string, WorkflowClassification | undefined> : {};
    for (const jobPath of uncached) {
      const value = parsed[jobPath];
      results.set(jobPath, setWorkflowClassificationCache(workflow, jobPath, value));
    }
  } catch {
    for (const jobPath of uncached) {
      results.set(jobPath, setWorkflowClassificationCache(workflow, jobPath, undefined));
    }
  }

  return results;
}

function workflowClassificationDetail(classification?: WorkflowClassification) {
  if (!classification) return undefined;
  return classification.detail
    || (typeof classification.payload?.last_assistant_message === 'string' ? classification.payload.last_assistant_message : undefined)
    || (typeof classification.payload?.last_notification_message === 'string' ? classification.payload.last_notification_message : undefined)
    || classification.tail;
}

function normalizeWorkflowState(
  workflow: WorkflowConfig,
  raw: Record<string, unknown>,
  classification: WorkflowClassification | undefined,
  tmuxExists: boolean,
  operatorMarkedStale: boolean,
  lastActivityAt?: string
): { state: JobState; reason: string; detail?: string; source: string } {
  if (operatorMarkedStale) return { state: 'stale', reason: 'operator_marked_stale', source: 'operator-override' };

  const detail = workflowClassificationDetail(classification);
  const reason = classification?.reason || 'workflow_classifier_unavailable';

  switch (workflow.classifyMode) {
    case 'implementation': {
      switch (classification?.state) {
        case 'running':
          return { state: 'running', reason, detail, source: 'workflow-classifier' };
        case 'needs_human_input':
          return { state: 'waiting_human', reason, detail, source: 'workflow-classifier' };
        case 'finished':
          return { state: 'waiting_review', reason, detail, source: 'workflow-classifier' };
        case 'stopped_unexpectedly':
          if (reason === 'pr_has_merge_conflicts_with_main') {
            return { state: 'conflicts', reason, detail, source: 'workflow-classifier' };
          }
          if (!tmuxExists) return { state: 'broken_missing_tmux', reason, detail, source: 'workflow-classifier' };
          if (lastActivityAt && minutesSince(lastActivityAt) > JOB_STALE_MINUTES) return { state: 'stale', reason, detail, source: 'workflow-classifier' };
          return { state: 'idle', reason, detail, source: 'workflow-classifier' };
      }
      break;
    }
    case 'concept-lab': {
      switch (classification?.state) {
        case 'running':
        case 'running_in_grace':
          return { state: 'running', reason, detail, source: 'workflow-classifier' };
        case 'waiting_for_human':
          return { state: 'waiting_human', reason, detail, source: 'workflow-classifier' };
        case 'ready_for_review':
          return { state: 'waiting_review', reason, detail, source: 'workflow-classifier' };
        case 'failed':
          return { state: 'failed', reason, detail, source: 'workflow-classifier' };
        case 'stuck':
          return { state: lastActivityAt && minutesSince(lastActivityAt) > JOB_STALE_MINUTES ? 'stale' : 'idle', reason, detail, source: 'workflow-classifier' };
      }
      break;
    }
    case 'tech-plan': {
      switch (classification?.state) {
        case 'planning':
        case 'reviewing':
          return { state: 'running', reason, detail, source: 'workflow-classifier' };
        case 'waiting_for_human':
          return { state: 'waiting_human', reason, detail, source: 'workflow-classifier' };
        case 'waiting_for_approval':
          return { state: 'waiting_approval', reason, detail, source: 'workflow-classifier' };
        case 'failed':
          return { state: 'failed', reason, detail, source: 'workflow-classifier' };
        case 'stopped_unknown':
          return { state: lastActivityAt && minutesSince(lastActivityAt) > JOB_STALE_MINUTES ? 'stale' : 'idle', reason, detail, source: 'workflow-classifier' };
      }
      break;
    }
  }

  const fallback = mapState(raw, tmuxExists, false, lastActivityAt);
  return { ...fallback, reason, detail, source: 'citadel-fallback' };
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

function cachedValue<T>(cache: Map<string, { expiresAt: number; value?: T }>, key: string) {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  return undefined;
}

function setCachedValue<T>(cache: Map<string, { expiresAt: number; value?: T }>, key: string, value: T | undefined, ttlMs: number) {
  cache.set(key, { expiresAt: Date.now() + ttlMs, value });
  return value;
}

function summarizeChecks(checks: unknown): string | undefined {
  if (!Array.isArray(checks) || checks.length === 0) return undefined;
  const buckets = new Map<string, number>();
  for (const check of checks) {
    const state = typeof (check as { conclusion?: unknown }).conclusion === 'string'
      ? String((check as { conclusion?: string }).conclusion)
      : typeof (check as { status?: unknown }).status === 'string'
        ? String((check as { status?: string }).status)
        : 'unknown';
    buckets.set(state, (buckets.get(state) || 0) + 1);
  }
  return Array.from(buckets.entries()).map(([state, count]) => `${count} ${state}`).join(' · ');
}

function expandCheckStatus(check: unknown) {
  const item = check as {
    conclusion?: unknown;
    status?: unknown;
    name?: unknown;
    context?: unknown;
    workflowName?: unknown;
  };
  return typeof item.conclusion === 'string'
    ? String(item.conclusion)
    : typeof item.status === 'string'
      ? String(item.status)
      : 'unknown';
}

function expandCheckName(check: unknown) {
  const item = check as {
    name?: unknown;
    context?: unknown;
    workflowName?: unknown;
  };
  return typeof item.name === 'string'
    ? String(item.name)
    : typeof item.context === 'string'
      ? String(item.context)
      : typeof item.workflowName === 'string'
        ? String(item.workflowName)
        : 'Unnamed check';
}

function extractChecks(checks: unknown) {
  if (!Array.isArray(checks) || checks.length === 0) return undefined;
  return checks.map((check) => ({
    name: expandCheckName(check),
    status: expandCheckStatus(check)
  }));
}

function classifyChecksState(
  prState: string | undefined,
  checks: unknown,
  mergeable?: string,
  mergeStateStatus?: string,
) {
  if (prState === 'MERGED') return { checksState: 'merged' as const, checksTooltip: 'PR merged' };
  if (mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') {
    return { checksState: 'failing' as const, checksTooltip: 'PR has merge conflicts' };
  }
  if (!Array.isArray(checks) || checks.length === 0) return { checksState: 'missing' as const, checksTooltip: 'No checks reported yet' };

  let pending = 0;
  let failing = 0;
  let passing = 0;

  for (const check of checks) {
    const conclusion = typeof (check as { conclusion?: unknown }).conclusion === 'string'
      ? String((check as { conclusion?: string }).conclusion)
      : undefined;
    const status = typeof (check as { status?: unknown }).status === 'string'
      ? String((check as { status?: string }).status)
      : undefined;

    if (status && status !== 'COMPLETED') {
      pending += 1;
      continue;
    }
    if (conclusion && ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion)) {
      failing += 1;
      continue;
    }
    if (conclusion && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion)) {
      passing += 1;
      continue;
    }
    pending += 1;
  }

  if (failing > 0) return { checksState: 'failing' as const, checksTooltip: `${failing} failing check${failing === 1 ? '' : 's'}` };
  if (pending > 0) return { checksState: 'pending' as const, checksTooltip: `${pending} check${pending === 1 ? '' : 's'} still running` };
  if (passing > 0) return { checksState: 'passing' as const, checksTooltip: 'All reported checks are green' };
  return { checksState: 'missing' as const, checksTooltip: 'Check status unavailable' };
}

export function fetchPullRequestSummary(prUrl?: string, prNumber?: number): PullRequestSummary | undefined {
  if (!prUrl) return undefined;
  const cached = cachedValue(prCache, prUrl);
  if (cached) return cached;
  try {
    const output = execFileSync('gh', [
      'pr',
      'view',
      prUrl,
      '--json',
      'number,title,state,reviewDecision,isDraft,statusCheckRollup,url,additions,deletions,mergeable,mergeStateStatus'
    ], {
      encoding: 'utf8',
      timeout: 900,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const parsed = JSON.parse(output) as {
      number?: number;
      title?: string;
      state?: string;
      reviewDecision?: string;
      isDraft?: boolean;
      statusCheckRollup?: unknown;
      url?: string;
      additions?: number;
      deletions?: number;
      mergeable?: string;
      mergeStateStatus?: string;
    };
    const checks = classifyChecksState(parsed.state, parsed.statusCheckRollup, parsed.mergeable, parsed.mergeStateStatus);
    return setCachedValue(prCache, prUrl, {
      refreshedAt: new Date().toISOString(),
      url: parsed.url || prUrl,
      number: parsed.number ?? prNumber,
      title: parsed.title,
      state: parsed.state,
      reviewDecision: parsed.reviewDecision,
      isDraft: parsed.isDraft,
      checksSummary: summarizeChecks(parsed.statusCheckRollup),
      checks: extractChecks(parsed.statusCheckRollup),
      checksState: checks.checksState,
      checksTooltip: checks.checksTooltip,
      additions: parsed.additions,
      deletions: parsed.deletions
    }, PR_CACHE_MS);
  } catch {
    return setCachedValue(prCache, prUrl, prNumber || prUrl ? { url: prUrl, number: prNumber, checksState: 'missing', checksTooltip: 'PR metadata unavailable', refreshedAt: new Date().toISOString() } : undefined, PR_CACHE_MS);
  }
}

export function fetchGitStatusSummary(worktreePath?: string): GitStatusSummary | undefined {
  if (!worktreePath) return undefined;
  const cached = cachedValue(gitStatusCache, worktreePath);
  if (cached) return cached;
  try {
    const output = execFileSync('git', ['-C', worktreePath, 'status', '--short', '--branch'], {
      encoding: 'utf8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const lines = output.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    const header = lines[0] || '';
    const summary: GitStatusSummary = {
      branch: undefined,
      ahead: 0,
      behind: 0,
      modified: 0,
      staged: 0,
      untracked: 0,
      deleted: 0,
      renamed: 0,
      conflicted: 0,
      clean: lines.length <= 1,
      lines: lines.slice(1, 13)
    };

    const branchMatch = header.match(/^##\s+([^\.]+)(?:\.\.\.[^\s]+)?(?:\s+\[(.*)\])?/);
    if (branchMatch) summary.branch = branchMatch[1];
    const aheadMatch = header.match(/ahead (\d+)/);
    const behindMatch = header.match(/behind (\d+)/);
    if (aheadMatch) summary.ahead = Number(aheadMatch[1]);
    if (behindMatch) summary.behind = Number(behindMatch[1]);

    for (const line of lines.slice(1)) {
      if (line.startsWith('??')) {
        summary.untracked += 1;
        continue;
      }
      const x = line[0] || ' ';
      const y = line[1] || ' ';
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) summary.conflicted += 1;
      if (x !== ' ' && x !== '?') summary.staged += 1;
      if (y !== ' ' && y !== '?') summary.modified += 1;
      if (x === 'D' || y === 'D') summary.deleted += 1;
      if (x === 'R' || y === 'R') summary.renamed += 1;
    }

    return setCachedValue(gitStatusCache, worktreePath, summary, GIT_STATUS_CACHE_MS);
  } catch {
    return setCachedValue(gitStatusCache, worktreePath, undefined, GIT_STATUS_CACHE_MS);
  }
}

function probeLinkHealth(url: string) {
  try {
    execFileSync('curl', ['-fsS', '--max-time', '0.5', '-o', '/dev/null', url], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 700
    });
    return true;
  } catch {
    return false;
  }
}

export function fetchDevLinks(worktreePath?: string): DevLink[] | undefined {
  if (!worktreePath) return undefined;
  const cached = cachedValue(devLinksCache, worktreePath);
  if (cached) return cached;
  try {
    const output = execFileSync('make', ['dev', 'links'], {
      cwd: worktreePath,
      encoding: 'utf8',
      env: { ...process.env, PATH: SYSTEM_PATH },
      timeout: 900,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const linkMap = new Map<string, DevLink>();
    const host = output.match(/https?:\/\/([^/:]+)/)?.[1] || '127.0.0.1';

    for (const line of output
      .split('\n')
      .map((value) => value.replace(/\x1b\[[0-9;]*m/g, '').trim())
      .filter(Boolean)) {
      const match = line.match(/^([A-Za-z0-9 _/-]+):\s+(https?:\/\/\S+)/);
      if (!match) continue;
      const label = match[1].trim();
      const url = match[2].trim();
      if (['api', 'admin'].includes(label.toLowerCase())) continue;
      linkMap.set(label.toLowerCase(), { label, url, healthy: probeLinkHealth(url) });
    }

    try {
      const portsOutput = execFileSync('make', ['dev', 'ports'], {
        cwd: worktreePath,
        encoding: 'utf8',
        env: { ...process.env, PATH: SYSTEM_PATH },
        timeout: 900,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      for (const line of portsOutput
        .split('\n')
        .map((value) => value.replace(/\x1b\[[0-9;]*m/g, '').trim())
        .filter(Boolean)) {
        const match = line.match(/^([A-Za-z0-9 _/-]+):\s+(\d+)/);
        if (!match) continue;
        const rawLabel = match[1].trim();
        const labelKey = rawLabel.toLowerCase();
        if (labelKey === 'app api' || labelKey === 'api') continue;
        if (linkMap.has(labelKey)) continue;
        if (!['dashboard', 'wizard', 'landing', 'blog', 'ovidiu', 'mailpit'].includes(labelKey)) continue;
        const url = `http://${host}:${match[2].trim()}`;
        linkMap.set(labelKey, { label: rawLabel, url, healthy: probeLinkHealth(url) });
      }
    } catch {}

    return setCachedValue(devLinksCache, worktreePath, Array.from(linkMap.values()), DEV_LINKS_CACHE_MS);
  } catch {
    return setCachedValue(devLinksCache, worktreePath, undefined, DEV_LINKS_CACHE_MS);
  }
}

function buildJobRecord(
  workflow: WorkflowConfig,
  jobPath: string,
  raw: Record<string, unknown>,
  tmuxSessions: Set<string>,
  workflowClassification?: WorkflowClassification
): JobRecord {
  const tmuxSession = getPath(raw, 'tmux_session');
  const tmuxExists = tmuxSession ? tmuxSessions.has(tmuxSession) : false;
  const operatorFlags = getOperatorFlags(String(raw.job_id || raw.run_id || jobPath));
  const slackThreadTs = getPath(raw, 'slack_thread_ts');
  const hasSlackThread = Boolean(slackThreadTs);
  const source = (typeof raw.job_source === 'string' ? raw.job_source : undefined) === 'citadel_manual' || raw.manual === true || raw.manual_origin === 'citadel'
    ? 'citadel_manual' as const
    : 'slack' as const;
  const manual = source === 'citadel_manual';
  const sourceLabel = typeof raw.job_source_label === 'string'
    ? raw.job_source_label
    : manual
      ? 'Manual'
      : 'Slack';
  const startMode = typeof raw.start_mode === 'string' ? raw.start_mode as JobRecord['startMode'] : undefined;
  const lastActivityAt = getLastActivityAt(raw);
  const liveTail = tmuxExists && tmuxSession ? captureTmuxTail(tmuxSession, 80) : '';
  const lastTmuxTailExcerpt = trimExcerpt(liveTail || workflowClassification?.tail || (raw.last_tmux_tail_excerpt as string | undefined));
  if (lastTmuxTailExcerpt) raw.last_tmux_tail_excerpt = lastTmuxTailExcerpt;
  const mapped = normalizeWorkflowState(workflow, raw, workflowClassification, tmuxExists, Boolean(operatorFlags.markedStaleAt), lastActivityAt);
  const classifierPr = workflowClassification?.pr;
  const reviewState = workflowClassification?.review_state as Record<string, unknown> | undefined;
  const latestFeedback = (raw.latest_feedback as Record<string, unknown> | undefined) || undefined;
  const feedbackPendingReview = latestFeedback?.dispatch_status === 'acknowledged' && !raw.feedback_applied_at;
  const prUrl = (classifierPr?.pr_url as string | undefined) || (raw.pr_url as string | undefined);
  const prNumber = typeof classifierPr?.pr_number === 'number'
    ? classifierPr.pr_number
    : typeof raw.pr_number === 'number'
      ? raw.pr_number
      : undefined;
  const classifierHasConflicts = Boolean(classifierPr?.has_conflicts);
  const fetchedPr = fetchPullRequestSummary(prUrl, prNumber);
  const livePrHasConflicts = fetchedPr?.checksTooltip === 'PR has merge conflicts' || fetchedPr?.checksState === 'failing' && fetchedPr?.checksTooltip === 'PR has merge conflicts';
  const effectivePrHasConflicts = Boolean(classifierHasConflicts || livePrHasConflicts);
  const pr: PullRequestSummary | undefined = prUrl
    ? {
        url: fetchedPr?.url || prUrl,
        number: fetchedPr?.number ?? prNumber,
        title: fetchedPr?.title,
        state: fetchedPr?.state,
        reviewDecision: fetchedPr?.reviewDecision,
        isDraft: fetchedPr?.isDraft,
        checksSummary: fetchedPr?.checksSummary,
        checks: fetchedPr?.checks,
        checksState: fetchedPr?.checksState || (effectivePrHasConflicts
          ? 'failing'
          : classifierPr?.checks_status === 'green'
            ? 'passing'
            : classifierPr?.checks_status === 'pending'
              ? 'pending'
              : classifierPr?.checks_status === 'failed'
                ? 'failing'
                : 'missing'),
        checksTooltip: fetchedPr?.checksTooltip || (effectivePrHasConflicts
          ? 'PR has merge conflicts'
          : classifierPr?.checks_status ? `Workflow reported PR checks: ${classifierPr.checks_status}` : 'PR metadata deferred'),
        additions: fetchedPr?.additions,
        deletions: fetchedPr?.deletions,
        refreshedAt: fetchedPr?.refreshedAt,
      }
    : undefined;
  const effectivePrChecksFailed = Boolean(!effectivePrHasConflicts && (
    fetchedPr?.checksState === 'failing' || classifierPr?.checks_status === 'failed'
  ));
  const effectiveMapped = effectivePrHasConflicts && workflow.classifyMode === 'implementation'
    ? { state: 'conflicts' as const, reason: 'pr_has_merge_conflicts_with_main', detail: mapped.detail, source: 'live-pr' }
    : effectivePrChecksFailed && workflow.classifyMode === 'implementation' && mapped.state === 'waiting_review'
      ? { state: 'ci_failed' as const, reason: 'pr_checks_failed', detail: mapped.detail, source: 'live-pr' }
      : mapped;
  const worktreePath = getPath(raw, 'worktree_path');

  return {
    id: String(raw.job_id || raw.run_id || jobPath),
    workflow: workflow.key,
    workflowLabel: workflow.label,
    channelId: workflow.channelId,
    source,
    sourceLabel,
    manual,
    hasSlackThread,
    startMode,
    jiraKey: raw.jira_key as string | undefined,
    title: summarizeTitle(workflow, raw),
    jiraUrl: raw.jira_url as string | undefined,
    prUrl,
    prNumber,
    pr,
    slackThreadTs,
    slack: {
      permalink: hasSlackThread && typeof slackThreadTs === 'string' ? buildSlackPermalink(workflow.channelId, slackThreadTs) : undefined
    },
    tmuxSession,
    tmuxExists,
    tmuxWindow: tmuxSession,
    worktreePath,
    transcriptPath: getPath(raw, 'transcript_path'),
    claudeSessionId: getPath(raw, 'claude_session_id') || (getPath(raw, 'transcript_path')?.split('/').pop()?.replace(/\.jsonl$/, '')),
    planPath: getPath(raw, 'plan_path'),
    requestPath: getPath(raw, 'request_path'),
    branchName: getPath(raw, 'branch_name'),
    gitStatus: undefined,
    devLinks: undefined,
    createdAt: getPath(raw, 'created_at'),
    updatedAt: getPath(raw, 'updated_at'),
    lastActivityAt,
    lastTmuxTailExcerpt,
    state: effectiveMapped.state,
    stateReason: effectiveMapped.reason,
    stateSource: effectiveMapped.source,
    statusDetail: effectiveMapped.detail,
    stateEvaluation: {
      finalState: effectiveMapped.state,
      finalReason: effectiveMapped.reason,
      source: effectiveMapped.source,
      classifierState: workflowClassification?.state,
      classifierReason: workflowClassification?.reason,
      classifierQuestion: typeof workflowClassification?.question === 'string' ? workflowClassification.question : undefined,
      prChecksStatus: typeof classifierPr?.checks_status === 'string' ? classifierPr.checks_status : undefined,
      reviewVerdict: typeof reviewState?.review_verdict === 'string' ? String(reviewState.review_verdict) : undefined,
      reviewReason: typeof reviewState?.reason === 'string' ? String(reviewState.reason) : undefined,
      feedbackPendingReview: Boolean(feedbackPendingReview),
      lastSentAction: typeof raw.last_sent_action === 'string' ? raw.last_sent_action : undefined,
      lastSentAt: typeof raw.last_sent_at === 'string' ? raw.last_sent_at : undefined,
      lastInboundClassification: typeof raw.last_inbound_classification === 'string' ? raw.last_inbound_classification : undefined,
      lastInboundReplyAt: typeof raw.last_inbound_reply_at === 'string' ? raw.last_inbound_reply_at : undefined,
      lastActivityAt,
    },
    operatorFlags,
    actions: {
      canReconcile: true,
      canCreateRecoveryShell: !tmuxExists && Boolean(tmuxSession),
      canOpenTerminal: Boolean(tmuxSession)
    },
    raw
  } satisfies JobRecord;
}

async function enrichJobRecord(job: JobRecord): Promise<JobRecord> {
  const pr = job.prUrl
    ? (fetchPullRequestSummary(job.prUrl, job.prNumber) || job.pr)
    : job.pr;
  return {
    ...job,
    pr,
    gitStatus: fetchGitStatusSummary(job.worktreePath),
    devLinks: fetchDevLinks(job.worktreePath)
  };
}

export async function collectJobs(): Promise<JobRecord[]> {
  const tmuxSessions = new Set(listTmuxSessions());
  const workflowJobPaths = new Map(WORKFLOWS.map((workflow) => [workflow.key, listJsonFiles(workflow.stateDir)]));
  const workflowClassifications = new Map<string, WorkflowClassification | undefined>();
  for (const workflow of WORKFLOWS) {
    const jobPaths = workflowJobPaths.get(workflow.key) || [];
    const classifications = runWorkflowClassifiers(workflow, jobPaths);
    for (const [jobPath, classification] of classifications.entries()) {
      workflowClassifications.set(`${workflow.key}:${jobPath}`, classification);
    }
  }

  const jobs = WORKFLOWS.flatMap((workflow) =>
    (workflowJobPaths.get(workflow.key) || []).map((jobPath) => {
      const raw = readJsonFile<Record<string, unknown>>(jobPath);
      if (!raw) return null;
      return buildJobRecord(workflow, jobPath, raw, tmuxSessions, workflowClassifications.get(`${workflow.key}:${jobPath}`));
    })
  );

  return jobs
    .filter(Boolean)
    .map((job) => job as JobRecord)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getJobSummaryById(jobId: string) {
  const jobs = await collectJobs();
  return jobs.find((job) => job.id === jobId);
}

export async function getJobById(jobId: string) {
  const job = await getJobSummaryById(jobId);
  if (!job) return undefined;
  return enrichJobRecord(job);
}

export function invalidateJobCaches(params: { prUrl?: string; worktreePath?: string }) {
  if (params.prUrl) prCache.delete(params.prUrl);
  if (params.worktreePath) {
    devLinksCache.delete(params.worktreePath);
    gitStatusCache.delete(params.worktreePath);
  }
}

export function invalidateWorkflowStateCache() {
  workflowStateCache.clear();
}

function waitForCommand(child: ReturnType<typeof spawn>, timeoutMs: number) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      reject(new Error('command_timeout'));
    }, timeoutMs);

    child.stdout?.on('data', (data) => chunks.push(String(data)));
    child.stderr?.on('data', (data) => chunks.push(String(data)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = chunks.join('').trim();
      if (code === 0) resolve({ code, output });
      else reject(new Error(output || `command_failed:${code ?? 'unknown'}`));
    });
  });
}

export function createManualWorkspace(input: ManualWorkspaceCreateInput) {
  if (input.workflow !== 'implementation') {
    throw new Error('manual_workspace_creation_only_supported_for_implementation');
  }

  const scriptPath = `${OPENCLAW_ROOT}/workspace-implementation/automation/implementation-jira/scripts/create-manual-job.py`;
  const output = execFileSync('python3', [scriptPath, JSON.stringify(input)], {
    encoding: 'utf8',
    timeout: 8 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, PATH: SYSTEM_PATH },
  });
  const parsed = JSON.parse(output) as { job_id?: string };
  if (!parsed.job_id) {
    throw new Error('manual_workspace_creation_missing_job_id');
  }
  return parsed;
}

export async function runWorktreeDeploy(worktreePath: string) {
  const child = spawn('make', ['dev', 'deploy'], {
    cwd: worktreePath,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return waitForCommand(child, 10 * 60 * 1000);
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
