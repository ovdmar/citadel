import { Box, GitPullRequest, Plus, RotateCw, RefreshCw, TerminalSquare, Wrench, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppCard, Button, Field, MetaRow, Surface, TextArea, TextInput } from '../components/ui';
import { StateBadge } from '../components/StateBadge';
import { nextActionLabel, priorityScore, topSignal } from '../components/ux';
import { createWorkspace, loadJobDevLinks, loadJobGit, loadJobPr, loadJobs, markJobStale, openShell, openTerminal, reconcileJob, recoverEngine, redeployJobDev, refreshJobPr, refreshJobState, relativeTime } from '../lib';
import type { GenericWorkflowState, ImplementationEngineView, JobRecord, PullRequestSummary } from '../types';

const workflowOrder = ['implementation', 'tech-plan', 'concept-lab'] as const;
const LAST_SELECTED_JOB_ID_KEY = 'citadel:last-selected-job-id';
const workflowStateOptions: Array<{ value: GenericWorkflowState | 'all'; label: string }> = [
  { value: 'all', label: 'All workflow states' },
  { value: 'running', label: 'Running' },
  { value: 'waiting_human', label: 'Waiting human' },
  { value: 'waiting_review', label: 'Waiting review' },
  { value: 'waiting_approval', label: 'Waiting approval' },
  { value: 'blocked_conflicts', label: 'Blocked by conflicts' },
  { value: 'blocked_ci', label: 'Blocked by CI' },
  { value: 'queued', label: 'Queued' },
  { value: 'idle', label: 'Idle' },
  { value: 'stale', label: 'Stale' },
  { value: 'broken', label: 'Broken' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
  { value: 'unknown', label: 'Unknown' },
];
const engineOptions: Array<{ value: JobRecord['engine']['kind'] | 'all'; label: string }> = [
  { value: 'all', label: 'All engines' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'unknown', label: 'Unknown engine' },
];

function sortByCreatedAtDesc<T extends { createdAt?: string }>(items: T[]) {
  return [...items].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });
}

function SlackIcon(props: { className?: string }) {
  return <img className={props.className} src="/icons/slack.png" alt="Slack" />;
}

function JiraIcon(props: { className?: string }) {
  return <img className={props.className} src="/icons/jira.svg" alt="Jira" />;
}

type CreateWorkspaceForm = {
  workflow: JobRecord['workflow'];
  title: string;
  jiraKey: string;
  startMode: NonNullable<JobRecord['startMode']>;
  branchName: string;
  prRef: string;
};

const defaultCreateWorkspaceForm = (): CreateWorkspaceForm => ({
  workflow: 'implementation',
  title: '',
  jiraKey: '',
  startMode: 'new',
  branchName: '',
  prRef: '',
});

function renderSlackButton(job: JobRecord, stopPropagation = false) {
  if (job.hasSlackThread && job.slack.permalink) {
    return (
      <a
        className="icon-link-button slack-link-button"
        href={job.slack.permalink}
        target="_blank"
        rel="noreferrer"
        onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
        title="Slack thread"
      >
        <SlackIcon className="brand-icon" />
      </a>
    );
  }
  return (
    <button
      type="button"
      className="icon-link-button slack-link-button disabled"
      disabled
      onClick={stopPropagation ? (event) => event.stopPropagation() : undefined}
      title="Manual workspace, no Slack thread"
    >
      <SlackIcon className="brand-icon" />
    </button>
  );
}

function renderSourceChip(job: JobRecord) {
  if (!job.manual) return null;
  return <span className="source-chip manual">{job.sourceLabel || 'Manual'}</span>;
}

function contextToneFromWorkflowState(state: GenericWorkflowState) {
  switch (state) {
    case 'running':
      return 'info';
    case 'waiting_review':
    case 'waiting_approval':
    case 'done':
      return 'ok';
    case 'waiting_human':
    case 'stale':
      return 'warn';
    case 'blocked_conflicts':
    case 'blocked_ci':
    case 'broken':
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

function contextToneFromEngine(engine: ImplementationEngineView) {
  switch (engine.state) {
    case 'running':
      return 'info';
    case 'completed':
      return 'ok';
    case 'waiting_human':
      return 'warn';
    case 'degraded':
    case 'missing':
      return 'danger';
    default:
      return 'neutral';
  }
}

function ContextChip({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'info' | 'ok' | 'warn' | 'danger' }) {
  return <span className={`context-chip context-chip-${tone}`}><strong>{label}</strong>{value}</span>;
}

function WorkflowChip({ job }: { job: JobRecord }) {
  return <ContextChip label="Workflow" value={job.workflowView.label} tone={contextToneFromWorkflowState(job.workflowView.state)} />;
}

function EngineChip({ job }: { job: JobRecord }) {
  return <ContextChip label="Engine" value={`${job.engine.label} · ${job.engine.stateLabel}`} tone={contextToneFromEngine(job.engine)} />;
}

function useIsMobile(breakpoint = 820) {
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' ? window.innerWidth <= breakpoint : false);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= breakpoint);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);

  return isMobile;
}

function formatPrSummary(job: JobRecord) {
  if (!job.pr) return null;
  return [
    job.pr.number ? `PR #${job.pr.number}` : (job.prNumber ? `PR #${job.prNumber}` : null),
    job.pr.state ? job.pr.state.toLowerCase() : null,
    job.pr.checksSummary
  ].filter(Boolean).join(' · ');
}

function hasPrDiff(pr?: PullRequestSummary) {
  return Boolean(pr && (typeof pr.additions === 'number' || typeof pr.deletions === 'number'));
}

function githubStatusClass(pr?: PullRequestSummary) {
  switch (pr?.checksState) {
    case 'pending': return 'github-icon-pending';
    case 'passing': return 'github-icon-passing';
    case 'failing': return 'github-icon-failing';
    case 'merged': return 'github-icon-merged';
    case 'missing':
    default:
      return pr ? 'github-icon-missing' : 'github-icon-none';
  }
}

type LoadingPhase = {
  active: boolean;
  blocking: boolean;
  progress: number;
  label: string;
  detail?: string;
};

function LoadingHud({ phase }: { phase: LoadingPhase }) {
  if (!phase.active) return null;
  return (
    <div className={`loading-hud ${phase.blocking ? 'blocking' : 'inline'}`}>
      <div className="loading-hud-card">
        <div className="loading-hud-topline">
          <span>{phase.label}</span>
          <span>{Math.max(4, Math.min(100, Math.round(phase.progress)))}%</span>
        </div>
        <div className="loading-hud-bar">
          <div className="loading-hud-fill" style={{ width: `${Math.max(4, Math.min(100, phase.progress))}%` }} />
        </div>
        <div className="loading-hud-detail">{phase.detail || 'Working...'}</div>
      </div>
    </div>
  );
}

function StateEvaluationCard({ job }: { job: JobRecord }) {
  const state = job.stateEvaluation;
  return (
    <AppCard className="side-top-card">
      <div className="overview-card-toprow">
        <div className="section-title">State evaluation</div>
        <StateBadge state={job.state} />
      </div>
      <div className="detail-grid compact-detail-grid">
        <MetaRow label="Final" value={`${job.workflowView.label} · ${job.workflowView.reason}`} />
        <MetaRow label="Source" value={state?.source || job.stateSource || '—'} mono />
        <MetaRow label="Classifier" value={state?.classifierState ? `${state.classifierState} · ${state.classifierReason || '—'}` : '—'} />
        <MetaRow label="PR checks" value={state?.prChecksStatus || '—'} />
        <MetaRow label="Review" value={state?.reviewVerdict ? `${state.reviewVerdict}${state.reviewReason ? ` · ${state.reviewReason}` : ''}` : '—'} />
        <MetaRow label="Feedback pending" value={state?.feedbackPendingReview ? 'yes' : 'no'} />
        <MetaRow label="Last sent" value={state?.lastSentAction || '—'} mono />
        <MetaRow label="Last inbound" value={state?.lastInboundClassification || '—'} mono />
      </div>
      {state?.classifierQuestion ? (
        <div>
          <div className="section-title">Classifier question</div>
          <pre>{state.classifierQuestion}</pre>
        </div>
      ) : null}
      {job.statusDetail ? (
        <details className="detail-disclosure">
          <summary>Why Citadel thinks this</summary>
          <div className="disclosure-grid">
            <pre>{job.statusDetail}</pre>
            {job.lastTmuxTailExcerpt ? <pre>{job.lastTmuxTailExcerpt}</pre> : null}
          </div>
        </details>
      ) : null}
    </AppCard>
  );
}

function TerminalPendingCard({
  loading,
  onLoadNow,
  children,
}: {
  loading: boolean;
  onLoadNow: () => void | Promise<void>;
  children?: ReactNode;
}) {
  return (
    <AppCard className="stream-placeholder terminal-pending-card">
      {loading ? (
        <div className="terminal-inline-loading">
          <div className="terminal-inline-spinner" />
          {children ? <div className="terminal-inline-loading-label">{children}</div> : null}
        </div>
      ) : (
        <div className="terminal-inline-idle">
          {children ? <div className="terminal-inline-loading-label">{children}</div> : null}
          <Button size="sm" variant="secondary" onClick={() => void onLoadNow()}>Load now</Button>
        </div>
      )}
    </AppCard>
  );
}

export function CockpitPage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [jobPrById, setJobPrById] = useState<Record<string, NonNullable<JobRecord['pr']>>>({});
  const [jobGitById, setJobGitById] = useState<Record<string, NonNullable<JobRecord['gitStatus']>>>({});
  const [jobDevLinksById, setJobDevLinksById] = useState<Record<string, NonNullable<JobRecord['devLinks']>>>({});
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [workflowStateFilter, setWorkflowStateFilter] = useState<GenericWorkflowState | 'all'>('all');
  const [engineFilter, setEngineFilter] = useState<JobRecord['engine']['kind'] | 'all'>('all');
  const [sortBy, setSortBy] = useState<'created_desc' | 'created_asc'>('created_desc');
  const [error, setError] = useState<string>('');
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateWorkspaceForm>(() => defaultCreateWorkspaceForm());
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileDetailTab, setMobileDetailTab] = useState<'stream' | 'stats'>('stream');
  const [aiUrl, setAiUrl] = useState('');
  const [shellUrl, setShellUrl] = useState('');
  const [terminalUrls, setTerminalUrls] = useState<Record<string, string>>({});
  const [shellTerminalUrls, setShellTerminalUrls] = useState<Record<string, string>>({});
  const [aiLoadingByJob, setAiLoadingByJob] = useState<Record<string, boolean>>({});
  const [shellLoadingByJob, setShellLoadingByJob] = useState<Record<string, boolean>>({});
  const [deployLoadingByJob, setDeployLoadingByJob] = useState<Record<string, boolean>>({});
  const [prRefreshLoadingByJob, setPrRefreshLoadingByJob] = useState<Record<string, boolean>>({});
  const [stateRefreshLoadingByJob, setStateRefreshLoadingByJob] = useState<Record<string, boolean>>({});
  const [jobPrLoadingById, setJobPrLoadingById] = useState<Record<string, boolean>>({});
  const [jobGitLoadingById, setJobGitLoadingById] = useState<Record<string, boolean>>({});
  const [jobDevLinksLoadingById, setJobDevLinksLoadingById] = useState<Record<string, boolean>>({});
  const [streamError, setStreamError] = useState('');
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [loadingPhase, setLoadingPhase] = useState<LoadingPhase>({
    active: true,
    blocking: true,
    progress: 8,
    label: 'Starting Citadel',
    detail: 'Connecting to the local operator cockpit'
  });
  const isMobile = useIsMobile();
  const aiInflightRef = useRef(new Map<string, Promise<string | undefined>>());
  const shellInflightRef = useRef(new Map<string, Promise<string | undefined>>());

  const showLoading = (progress: number, label: string, detail?: string, blocking = false) => {
    setLoadingPhase({ active: true, blocking, progress, label, detail });
  };

  const finishLoading = (label = 'Ready', detail = 'Workspace loaded') => {
    setLoadingPhase((current) => ({ ...current, active: true, blocking: false, progress: 100, label, detail }));
    window.setTimeout(() => {
      setLoadingPhase((current) => ({ ...current, active: false, blocking: false }));
    }, 450);
  };

  const refresh = async (silent = false) => {
    try {
      if (!silent) showLoading(18, 'Loading workspaces', 'Reading active jobs and current workflow state', !hasLoadedOnce);
      const response = await loadJobs();
      if (!silent) showLoading(56, 'Preparing cockpit', `Loaded ${response.jobs.length} workspace${response.jobs.length === 1 ? '' : 's'}`, !hasLoadedOnce);
      const ranked = [...response.jobs].sort((a, b) => priorityScore(b) - priorityScore(a));
      const newestFirst = sortByCreatedAtDesc(response.jobs);
      setJobs(ranked);
      setSelectedJobId((current) => {
        if (current && response.jobs.some((job) => job.id === current)) return current;
        const saved = typeof window !== 'undefined' ? window.localStorage.getItem(LAST_SELECTED_JOB_ID_KEY) : '';
        if (saved && response.jobs.some((job) => job.id === saved)) return saved;
        return newestFirst[0]?.id;
      });
      setError('');
      if (!silent) {
        setHasLoadedOnce(true);
        finishLoading(ranked.length ? 'Ready' : 'Ready', ranked.length ? `Loaded ${ranked.length} workspace${ranked.length === 1 ? '' : 's'}` : 'No active workspaces right now');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed_to_load_jobs');
      if (!silent) {
        setLoadingPhase({
          active: true,
          blocking: !hasLoadedOnce,
          progress: 100,
          label: 'Load failed',
          detail: err instanceof Error ? err.message : 'failed_to_load_jobs'
        });
      }
    }
  };

  const openCreateModal = () => {
    setCreateForm(defaultCreateWorkspaceForm());
    setCreateError('');
    setCreateModalOpen(true);
  };

  const closeCreateModal = () => {
    if (createLoading) return;
    setCreateModalOpen(false);
    setCreateError('');
  };

  const submitCreateWorkspace = async () => {
    setCreateError('');
    if (createForm.startMode === 'new' && !createForm.title.trim() && !createForm.jiraKey.trim()) {
      setCreateError('Title or Jira task is required for a new manual workspace.');
      return;
    }
    if (createForm.startMode === 'existing_branch' && !createForm.branchName.trim()) {
      setCreateError('Branch name is required for existing branch mode.');
      return;
    }
    if (createForm.startMode === 'existing_pr' && !createForm.prRef.trim()) {
      setCreateError('PR URL or PR number is required for existing PR mode.');
      return;
    }

    try {
      setCreateLoading(true);
      showLoading(22, 'Creating workspace', 'Provisioning the manual workspace and launching the workflow', false);
      const response = await createWorkspace({
        workflow: createForm.workflow,
        title: createForm.title.trim() || undefined,
        jiraKey: createForm.jiraKey.trim() || undefined,
        startMode: createForm.startMode,
        branchName: createForm.startMode === 'existing_branch' ? createForm.branchName.trim() : undefined,
        prRef: createForm.startMode === 'existing_pr' ? createForm.prRef.trim() : undefined,
      });
      await refresh(true);
      if (response.job?.id) {
        setSelectedJobId(response.job.id);
        if (isMobile) setMobileView('detail');
      }
      setCreateModalOpen(false);
      finishLoading('Workspace created', 'Manual workspace launched');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'workspace_create_failed');
      setLoadingPhase((current) => ({ ...current, active: false, blocking: false }));
    } finally {
      setCreateLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const mergedJobs = useMemo(() => jobs.map((job) => ({
    ...job,
    pr: jobPrById[job.id] || job.pr,
    gitStatus: jobGitById[job.id] || job.gitStatus,
    devLinks: jobDevLinksById[job.id] || job.devLinks,
  })), [jobs, jobPrById, jobGitById, jobDevLinksById]);

  const filteredJobs = useMemo(() => {
    const filtered = mergedJobs.filter((job) => {
      if (workflowFilter !== 'all' && job.workflow !== workflowFilter) return false;
      if (workflowStateFilter !== 'all' && job.workflowView.state !== workflowStateFilter) return false;
      if (engineFilter !== 'all' && job.engine.kind !== engineFilter) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortBy === 'created_asc' ? aTime - bTime : bTime - aTime;
    });
  }, [mergedJobs, workflowFilter, workflowStateFilter, engineFilter, sortBy]);

  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) || filteredJobs[0];
  const selectedJobPrLoading = selectedJob ? Boolean(jobPrLoadingById[selectedJob.id]) : false;
  const selectedJobGitLoading = selectedJob ? Boolean(jobGitLoadingById[selectedJob.id]) : false;
  const selectedJobDevLinksLoading = selectedJob ? Boolean(jobDevLinksLoadingById[selectedJob.id]) : false;

  useEffect(() => {
    if (!selectedJob) return;
    if (!terminalUrls[selectedJob.id]) return;
    if (jobPrById[selectedJob.id] || jobPrLoadingById[selectedJob.id] || !selectedJob.prUrl) return;
    const jobId = selectedJob.id;
    let cancelled = false;
    setJobPrLoadingById((current) => ({ ...current, [jobId]: true }));
    void loadJobPr(jobId)
      .then((response) => {
        if (cancelled || !response.pr) return;
        setJobPrById((current) => ({ ...current, [jobId]: response.pr! }));
      })
      .catch(() => {})
      .finally(() => {
        setJobPrLoadingById((current) => {
          const next = { ...current };
          delete next[jobId];
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [selectedJob?.id, selectedJob?.prUrl, terminalUrls, jobPrById]);

  useEffect(() => {
    if (!selectedJob) return;
    if (!terminalUrls[selectedJob.id]) return;
    if (jobGitById[selectedJob.id] || jobGitLoadingById[selectedJob.id]) return;
    const jobId = selectedJob.id;
    let cancelled = false;
    setJobGitLoadingById((current) => ({ ...current, [jobId]: true }));
    void loadJobGit(jobId)
      .then((response) => {
        if (cancelled || !response.gitStatus) return;
        setJobGitById((current) => ({ ...current, [jobId]: response.gitStatus! }));
      })
      .catch(() => {})
      .finally(() => {
        setJobGitLoadingById((current) => {
          const next = { ...current };
          delete next[jobId];
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [selectedJob?.id, terminalUrls, jobGitById]);

  useEffect(() => {
    if (!selectedJob?.worktreePath) return;
    if (!terminalUrls[selectedJob.id]) return;
    if (jobDevLinksById[selectedJob.id] || jobDevLinksLoadingById[selectedJob.id]) return;
    const jobId = selectedJob.id;
    let cancelled = false;
    setJobDevLinksLoadingById((current) => ({ ...current, [jobId]: true }));
    void loadJobDevLinks(jobId)
      .then((response) => {
        if (cancelled || !response.devLinks) return;
        setJobDevLinksById((current) => ({ ...current, [jobId]: response.devLinks! }));
      })
      .catch(() => {})
      .finally(() => {
        setJobDevLinksLoadingById((current) => {
          const next = { ...current };
          delete next[jobId];
          return next;
        });
      });
    return () => { cancelled = true; };
  }, [selectedJob?.id, selectedJob?.worktreePath, terminalUrls, jobDevLinksById]);

  useEffect(() => {
    if (!selectedJob?.prUrl) return;
    const timer = window.setInterval(() => {
      void loadJobPr(selectedJob.id)
        .then((response) => {
          if (response.pr) setJobPrById((current) => ({ ...current, [selectedJob.id]: response.pr! }));
        })
        .catch(() => {});
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [selectedJob?.id, selectedJob?.prUrl]);

  const ensureAiTerminal = async (job: JobRecord) => {
    const cached = terminalUrls[job.id];
    if (cached) return cached;
    const inflight = aiInflightRef.current.get(job.id);
    if (inflight) return inflight;

    setAiLoadingByJob((current) => ({ ...current, [job.id]: true }));
    const promise = openTerminal(job.id)
      .then((response) => {
        const url = response.terminal.url;
        setTerminalUrls((current) => current[job.id] ? current : { ...current, [job.id]: url });
        return url;
      })
      .finally(() => {
        aiInflightRef.current.delete(job.id);
        setAiLoadingByJob((current) => {
          const next = { ...current };
          delete next[job.id];
          return next;
        });
      });

    aiInflightRef.current.set(job.id, promise);
    return promise;
  };

  const ensureShellTerminal = async (job: JobRecord) => {
    if (!job.worktreePath) return undefined;
    const cached = shellTerminalUrls[job.id];
    if (cached) return cached;
    const inflight = shellInflightRef.current.get(job.id);
    if (inflight) return inflight;

    setShellLoadingByJob((current) => ({ ...current, [job.id]: true }));
    const promise = openShell(job.id)
      .then((response) => {
        const url = response.terminal.url;
        setShellTerminalUrls((current) => current[job.id] ? current : { ...current, [job.id]: url });
        return url;
      })
      .finally(() => {
        shellInflightRef.current.delete(job.id);
        setShellLoadingByJob((current) => {
          const next = { ...current };
          delete next[job.id];
          return next;
        });
      });

    shellInflightRef.current.set(job.id, promise);
    return promise;
  };

  const handleRedeployDev = async (job: JobRecord) => {
    setDeployLoadingByJob((current) => ({ ...current, [job.id]: true }));
    try {
      const response = await redeployJobDev(job.id) as { job?: JobRecord };
      if (response.job?.devLinks) setJobDevLinksById((current) => ({ ...current, [job.id]: response.job!.devLinks! }));
      if (response.job?.gitStatus) setJobGitById((current) => ({ ...current, [job.id]: response.job!.gitStatus! }));
      await refresh(true);
    } finally {
      setDeployLoadingByJob((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };

  const handleRefreshPr = async (job: JobRecord) => {
    setPrRefreshLoadingByJob((current) => ({ ...current, [job.id]: true }));
    try {
      const response = await refreshJobPr(job.id) as { job?: JobRecord };
      if (response.job?.pr) setJobPrById((current) => ({ ...current, [job.id]: response.job!.pr! }));
      await refresh(true);
    } finally {
      setPrRefreshLoadingByJob((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };

  const handleRefreshState = async (job: JobRecord) => {
    setStateRefreshLoadingByJob((current) => ({ ...current, [job.id]: true }));
    try {
      const response = await refreshJobState(job.id);
      if (response.job?.pr) setJobPrById((current) => ({ ...current, [job.id]: response.job!.pr! }));
      if (response.job?.gitStatus) setJobGitById((current) => ({ ...current, [job.id]: response.job!.gitStatus! }));
      if (response.job?.devLinks) setJobDevLinksById((current) => ({ ...current, [job.id]: response.job!.devLinks! }));
      await refresh(true);
    } finally {
      setStateRefreshLoadingByJob((current) => {
        const next = { ...current };
        delete next[job.id];
        return next;
      });
    }
  };

  useEffect(() => {
    if (selectedJob && selectedJob.id !== selectedJobId) setSelectedJobId(selectedJob.id);
  }, [selectedJob, selectedJobId]);

  useEffect(() => {
    if (!selectedJob || typeof window === 'undefined') return;
    window.localStorage.setItem(LAST_SELECTED_JOB_ID_KEY, selectedJob.id);
  }, [selectedJob?.id]);

  useEffect(() => {
    if (!selectedJob) return;
    const cachedUrl = terminalUrls[selectedJob.id];
    setAiUrl(cachedUrl || '');
    setStreamError('');
    if (cachedUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const url = await ensureAiTerminal(selectedJob);
        if (cancelled) return;
        setAiUrl(url || '');
        setStreamError('');
      } catch (err) {
        if (cancelled) return;
        setAiUrl('');
        setStreamError(err instanceof Error ? err.message : 'terminal_open_failed');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedJob?.id, terminalUrls]);

  useEffect(() => {
    if (!selectedJob) {
      setShellUrl('');
      return;
    }
    setAiUrl(terminalUrls[selectedJob.id] || '');
    setShellUrl(shellTerminalUrls[selectedJob.id] || '');
  }, [selectedJob?.id, terminalUrls, shellTerminalUrls]);

  useEffect(() => {
    if (!isMobile) {
      setMobileView('list');
      setMobileFiltersOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (mobileView === 'detail') setMobileDetailTab('stream');
  }, [selectedJob?.id, mobileView]);

  const createModal = createModalOpen ? (
    <div className="modal-backdrop" onClick={closeCreateModal}>
      <div className="modal-card create-workspace-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <div className="section-title">Create workspace</div>
            <div className="muted">Manual Citadel workspace, no Slack thread.</div>
          </div>
          <button type="button" className="modal-close" onClick={closeCreateModal} disabled={createLoading}>
            <X size={16} />
          </button>
        </div>

        <div className="modal-form-grid">
          <label className="modal-field">
            <span>Workflow</span>
            <Field value={createForm.workflow} onChange={(event) => setCreateForm((current) => ({ ...current, workflow: event.target.value as JobRecord['workflow'] }))}>
              <option value="implementation">Implementation</option>
            </Field>
          </label>

          <label className="modal-field">
            <span>Title</span>
            <TextInput value={createForm.title} onChange={(event) => setCreateForm((current) => ({ ...current, title: event.target.value }))} placeholder="Required if no Jira task is attached" />
          </label>

          <label className="modal-field">
            <span>Jira task</span>
            <TextInput value={createForm.jiraKey} onChange={(event) => setCreateForm((current) => ({ ...current, jiraKey: event.target.value.toUpperCase() }))} placeholder="Optional, for example MS-123" />
          </label>

          <label className="modal-field">
            <span>Start from</span>
            <Field value={createForm.startMode} onChange={(event) => setCreateForm((current) => ({ ...current, startMode: event.target.value as CreateWorkspaceForm['startMode'] }))}>
              <option value="new">New workspace</option>
              <option value="existing_branch">Existing branch</option>
              <option value="existing_pr">Existing PR</option>
            </Field>
          </label>

          {createForm.startMode === 'existing_branch' ? (
            <label className="modal-field">
              <span>Branch name</span>
              <TextInput value={createForm.branchName} onChange={(event) => setCreateForm((current) => ({ ...current, branchName: event.target.value }))} placeholder="feature/my-branch" />
            </label>
          ) : null}

          {createForm.startMode === 'existing_pr' ? (
            <label className="modal-field">
              <span>PR URL or number</span>
              <TextInput value={createForm.prRef} onChange={(event) => setCreateForm((current) => ({ ...current, prRef: event.target.value }))} placeholder="https://github.com/.../pull/123 or 123" />
            </label>
          ) : null}

          <label className="modal-field modal-field-full">
            <span>Notes</span>
            <TextArea value={createForm.startMode === 'new' ? 'Fresh workspace from Citadel, optionally attached to Jira.' : createForm.startMode === 'existing_branch' ? 'Fresh workspace that checks out the requested branch.' : 'Fresh workspace that checks out the requested PR branch.'} readOnly rows={3} />
          </label>
        </div>

        {createError ? <div className="error-text modal-error">{createError}</div> : null}

        <div className="modal-actions">
          <Button variant="ghost" onClick={closeCreateModal} disabled={createLoading}>Cancel</Button>
          <Button onClick={() => void submitCreateWorkspace()} disabled={createLoading}>{createLoading ? 'Creating…' : 'Create workspace'}</Button>
        </div>
      </div>
    </div>
  ) : null;

  if (isMobile) {
    return (
      <div className="page-shell jarvis-shell mobile-citadel-shell">
        <LoadingHud phase={loadingPhase} />
        {createModal}
        <header className={`cockpit-header-card mobile-header-card ${mobileView === 'detail' ? 'detail' : ''}`}>
          <div className="cockpit-title-block">
            <div className="eyebrow-row">Citadel mobile</div>
            <h2>{mobileView === 'detail' ? (selectedJob?.jiraKey || 'Workspace') : 'Workspaces'}</h2>
            <p>{mobileView === 'detail' ? (selectedJob?.title || 'Workspace detail') : `${filteredJobs.length} visible`}</p>
            {error ? <p className="error-text">{error}</p> : null}
          </div>
          <div className="mobile-header-actions">
            {mobileView === 'detail' ? <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>Back</Button> : null}
            <Button size="sm" onClick={openCreateModal}><Plus size={14} /> Create</Button>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
            {mobileView === 'list' ? <Button size="sm" variant="ghost" onClick={() => setMobileFiltersOpen((open) => !open)}>{mobileFiltersOpen ? 'Hide filters' : 'Filters'}</Button> : null}
          </div>
        </header>
        {mobileView === 'list' ? (
          <>
            {mobileFiltersOpen ? (
              <div className="workspace-filters mobile-filters-card">
                <Field value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
                  <option value="all">All workflows</option>
                  {workflowOrder.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
                </Field>
                <Field value={workflowStateFilter} onChange={(e) => setWorkflowStateFilter(e.target.value as GenericWorkflowState | 'all')}>
                  {workflowStateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Field>
                <Field value={engineFilter} onChange={(e) => setEngineFilter(e.target.value as JobRecord['engine']['kind'] | 'all')}>
                  {engineOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Field>
                <Field value={sortBy} onChange={(e) => setSortBy(e.target.value as 'created_desc' | 'created_asc')}>
                  <option value="created_desc">Newest first</option>
                  <option value="created_asc">Oldest first</option>
                </Field>
              </div>
            ) : null}
            <div className="mobile-workspace-list">
              {filteredJobs.map((job) => (
                <button key={job.id} className="workspace-row" onClick={() => { setSelectedJobId(job.id); setMobileView('detail'); }}>
                  <div className="mobile-workspace-card-body">
                    <div className="job-key-row">
                      <div className="job-key">{job.jiraKey || job.id}</div>
                      {renderSourceChip(job)}
                    </div>
                    <div className="workspace-title">{job.title}</div>
                    <div className="chip-row">
                      <WorkflowChip job={job} />
                      <EngineChip job={job} />
                    </div>
                    <div className="mobile-card-icons-row">
                      {renderSlackButton(job, true)}
                      {job.jiraUrl ? <a className="icon-link-button jira-link-button" href={job.jiraUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                      <a className={`icon-link-button ${githubStatusClass(job.pr)}`} href={job.pr?.url || job.prUrl || '#'} target="_blank" rel="noreferrer" title={job.pr?.checksTooltip || (job.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { event.stopPropagation(); if (!job.pr && !job.prUrl) event.preventDefault(); }}>
                        <GitPullRequest size={15} />
                      </a>
                      {hasPrDiff(job.pr) ? (
                        <div className="pr-diff-summary mobile-pr-diff-summary">
                          <span className="pr-diff-added">+{job.pr.additions || 0}</span>
                          <span className="pr-diff-removed">-{job.pr.deletions || 0}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                  <StateBadge state={job.state} />
                </button>
              ))}
            </div>
          </>
        ) : selectedJob ? (
          <div className="mobile-detail-stack">
            <div className="mobile-detail-toggle-row">
              <Button size="sm" variant={mobileDetailTab === 'stream' ? 'default' : 'secondary'} onClick={() => setMobileDetailTab('stream')}>AI stream</Button>
              <Button size="sm" variant={mobileDetailTab === 'stats' ? 'default' : 'secondary'} onClick={() => setMobileDetailTab('stats')}>Stats</Button>
            </div>

            {mobileDetailTab === 'stream' ? (
              <div className="mobile-terminal-block mobile-terminal-block-full">
                <div className="mobile-terminal-header">
                  <div>
                    <div className="section-title">{selectedJob.engine.terminalTitle}</div>
                    <div className="shell-pane-subtitle">Live session for this workspace</div>
                  </div>
                  <div className="mobile-terminal-actions">
                    {aiUrl ? <Button size="sm" variant="ghost" onClick={() => { window.location.href = aiUrl; }}>Open full screen</Button> : null}
                    <Button size="sm" variant="secondary" onClick={async () => { const url = await ensureAiTerminal(selectedJob); setAiUrl(url || ''); setStreamError(''); }}><TerminalSquare size={14} /> Reattach</Button>
                  </div>
                </div>
                {streamError ? <AppCard className="stream-error-card">Execution stream unavailable: {streamError}</AppCard> : null}
                {aiUrl ? <iframe key={`mobile-ai-${selectedJob.id}-${aiUrl}`} className="mobile-terminal-frame mobile-terminal-frame-large" src={aiUrl} title="mobile-ai-stream" /> : <TerminalPendingCard loading={Boolean(aiLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureAiTerminal(selectedJob); }}>{selectedJob.engine.terminalTitle}</TerminalPendingCard>}
              </div>
            ) : (
              <div className="mobile-stats-stack">
                <AppCard>
                  <div className="mobile-hero-topline">
                    <div>
                      <div className="section-title">Workspace overview</div>
                      <div className="decision-title">{nextActionLabel(selectedJob)}</div>
                    </div>
                    <StateBadge state={selectedJob.state} />
                  </div>
                  <div className="decision-body">{topSignal(selectedJob)}</div>
                  <div className="mobile-meta-list">
                    <span>{selectedJob.workflowLabel}</span>
                    <span>{relativeTime(selectedJob.lastActivityAt)}</span>
                    {selectedJob.pr?.number ? <span>PR #{selectedJob.pr.number}</span> : (selectedJob.prNumber ? <span>PR #{selectedJob.prNumber}</span> : null)}
                    {selectedJob.manual ? <span>{selectedJob.sourceLabel}</span> : null}
                  </div>
                  <div className="chip-row">
                    <WorkflowChip job={selectedJob} />
                    <EngineChip job={selectedJob} />
                  </div>
                  <div className="icon-links-row overview-icon-links mobile-overview-icons">
                    {renderSlackButton(selectedJob)}
                    {selectedJob.jiraUrl ? <a className="icon-link-button jira-link-button" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer" title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                    <a className={`icon-link-button ${githubStatusClass(selectedJob.pr)}`} href={selectedJob.pr?.url || selectedJob.prUrl || '#'} target="_blank" rel="noreferrer" title={selectedJob.pr?.checksTooltip || (selectedJob.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { if (!selectedJob.pr && !selectedJob.prUrl) event.preventDefault(); }}>
                      <GitPullRequest size={15} />
                    </a>
                    {hasPrDiff(selectedJob.pr) ? (
                      <div className="pr-diff-summary mobile-pr-diff-summary">
                        <span className="pr-diff-added">+{selectedJob.pr.additions || 0}</span>
                        <span className="pr-diff-removed">-{selectedJob.pr.deletions || 0}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="side-action-row">
                    <Button size="sm" variant="secondary" onClick={() => void handleRefreshState(selectedJob)} disabled={Boolean(stateRefreshLoadingByJob[selectedJob.id])}><RotateCw size={14} /> {stateRefreshLoadingByJob[selectedJob.id] ? 'Refreshing…' : 'Refresh state'}</Button>
                    <Button size="sm" variant="secondary" onClick={async () => { await reconcileJob(selectedJob.id); await refresh(); }}><RefreshCw size={14} /> Reconcile</Button>
                    <Button size="sm" variant="ghost" onClick={async () => { await markJobStale(selectedJob.id, !selectedJob.operatorFlags.markedStaleAt); await refresh(); }}>{selectedJob.operatorFlags.markedStaleAt ? 'Clear stale' : 'Mark stale'}</Button>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      setAiUrl('');
                      const r = await openTerminal(selectedJob.id, true);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.actions.canCreateRecoveryShell}><Wrench size={14} /> Recover tmux</Button>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      setAiUrl('');
                      const r = await recoverEngine(selectedJob.id);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.actions.canRecoverEngine}><Wrench size={14} /> Recover {selectedJob.engine.label}</Button>
                  </div>
                </AppCard>

                <AppCard>
                  <div className="overview-card-toprow">
                    <div className="section-title">Container links</div>
                    <Button size="sm" variant="secondary" onClick={() => void handleRedeployDev(selectedJob)} disabled={!selectedJob.worktreePath || Boolean(deployLoadingByJob[selectedJob.id])}>{deployLoadingByJob[selectedJob.id] ? 'Deploying…' : 'Redeploy'}</Button>
                  </div>
                  {selectedJob.devLinks?.length ? (
                    <div className="dev-links-grid">
                      {selectedJob.devLinks.map((link) => (
                        <a key={link.url} className="dev-link-chip" href={link.url} target="_blank" rel="noreferrer" title={link.healthy ? 'Container healthy' : 'Container unhealthy'}>
                          <Box size={12} className={link.healthy ? 'dev-link-healthy' : 'dev-link-unhealthy'} />
                          <span>{link.label}</span>
                        </a>
                      ))}
                    </div>
                  ) : <div className="muted">No container links for this workspace yet.</div>}
                </AppCard>

                <StateEvaluationCard job={selectedJob} />

                <AppCard>
                  <div className="section-title">Workspace stats</div>
                  <div className="detail-grid compact-detail-grid">
                    <Surface><MetaRow label="Engine" value={`${selectedJob.engine.label} · ${selectedJob.engine.stateLabel}`} /></Surface>
                    <Surface><MetaRow label={`${selectedJob.engine.label} session`} value={selectedJob.engine.sessionId || '—'} mono /></Surface>
                    <Surface><MetaRow label="Branch" value={selectedJob.branchName || selectedJob.gitStatus?.branch || '—'} mono /></Surface>
                    <Surface><MetaRow label="Workflow" value={selectedJob.workflowView.label} /></Surface>
                  </div>
                </AppCard>

                <AppCard>
                  <div className="overview-card-toprow">
                    <div className="section-title">PR stats</div>
                    <Button size="sm" variant="secondary" onClick={() => void handleRefreshPr(selectedJob)} disabled={!selectedJob.prUrl || Boolean(prRefreshLoadingByJob[selectedJob.id])}>{prRefreshLoadingByJob[selectedJob.id] ? 'Refreshing…' : 'Refresh'}</Button>
                  </div>
                  {selectedJob.pr ? (
                    <>
                      <a className="inline-link pr-link-block" href={selectedJob.pr.url} target="_blank" rel="noreferrer">
                        <GitPullRequest size={14} className={githubStatusClass(selectedJob.pr)} />
                        <span>{selectedJob.pr.title || `PR #${selectedJob.pr.number || selectedJob.prNumber}`}</span>
                      </a>
                      {selectedJob.pr.refreshedAt ? <div className="muted">Last refresh {relativeTime(selectedJob.pr.refreshedAt)}</div> : null}
                      {selectedJob.pr.checks?.length ? (
                        <div className="pr-checks-list">
                          {selectedJob.pr.checks.map((check) => (
                            <div key={`${check.name}:${check.status}`} className="pr-check-row">
                              <span className={`pr-check-status pr-check-status-${check.status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{check.status}</span>
                              <span className="pr-check-name">{check.name}</span>
                            </div>
                          ))}
                        </div>
                      ) : <div className="muted">No checks reported yet.</div>}
                    </>
                  ) : <div className="muted">No PR linked yet.</div>}
                </AppCard>

                <AppCard className={selectedJob.gitStatus?.clean ? 'side-top-card git-status-clean-card' : 'side-top-card'}>
                  <div className="section-title">Git status</div>
                  {selectedJob.gitStatus ? (
                    <>
                      <div className="mobile-meta-list">
                        <span>{selectedJob.gitStatus.clean ? 'clean' : 'dirty'}</span>
                        {selectedJob.gitStatus.ahead ? <span>ahead {selectedJob.gitStatus.ahead}</span> : null}
                        {selectedJob.gitStatus.behind ? <span>behind {selectedJob.gitStatus.behind}</span> : null}
                        {selectedJob.gitStatus.untracked ? <span>{selectedJob.gitStatus.untracked} untracked</span> : null}
                        {selectedJob.gitStatus.modified ? <span>{selectedJob.gitStatus.modified} modified</span> : null}
                        {selectedJob.gitStatus.staged ? <span>{selectedJob.gitStatus.staged} staged</span> : null}
                      </div>
                      {selectedJob.gitStatus.clean ? <div className="muted">Working tree clean.</div> : (selectedJob.gitStatus.lines.length ? <pre>{selectedJob.gitStatus.lines.join('\n')}</pre> : <div className="muted">Git status unavailable.</div>)}
                    </>
                  ) : <div className="muted">Git status unavailable.</div>}
                </AppCard>

                <div className="mobile-terminal-block mobile-shell-block">
                  <div className="mobile-terminal-header">
                    <div>
                      <div className="section-title">Worktree terminal</div>
                      <div className="shell-pane-subtitle">Plain shell inside this workspace</div>
                    </div>
                    <div className="mobile-terminal-actions">
                      {shellUrl ? <Button size="sm" variant="ghost" onClick={() => { window.location.href = shellUrl; }}>Open full screen</Button> : null}
                      <Button size="sm" variant="secondary" onClick={async () => {
                        const url = await ensureShellTerminal(selectedJob);
                        setShellUrl(url || '');
                      }}><TerminalSquare size={14} /> Reattach</Button>
                    </div>
                  </div>
                  {shellUrl ? <iframe key={`mobile-shell-${selectedJob.id}-${shellUrl}`} className="mobile-terminal-frame mobile-shell-frame" src={shellUrl} title="mobile-shell-stream" /> : <TerminalPendingCard loading={Boolean(shellLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureShellTerminal(selectedJob); }}>Worktree terminal</TerminalPendingCard>}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page-shell jarvis-shell superset-shell">
      <LoadingHud phase={loadingPhase} />
      {createModal}
      <div className="superset-layout">
        <aside className="workspace-nav-pane">
          <div className="workspace-nav-top">
            <div>
              <div className="eyebrow-row">Workspaces</div>
              <h2 className="workspace-pane-title">Active workspaces</h2>
              <div className="workspace-subtle">{filteredJobs.length} visible</div>
            </div>
            <div className="workspace-nav-actions">
              <Button size="sm" onClick={openCreateModal}><Plus size={14} /> Create workspace</Button>
              <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
            </div>
          </div>

          <div className="workspace-filters">
            <Field value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
              <option value="all">All workflows</option>
              {workflowOrder.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
            </Field>
            <Field value={workflowStateFilter} onChange={(e) => setWorkflowStateFilter(e.target.value as GenericWorkflowState | 'all')}>
              {workflowStateOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Field>
            <Field value={engineFilter} onChange={(e) => setEngineFilter(e.target.value as JobRecord['engine']['kind'] | 'all')}>
              {engineOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </Field>
            <Field value={sortBy} onChange={(e) => setSortBy(e.target.value as 'created_desc' | 'created_asc')}>
              <option value="created_desc">Newest first</option>
              <option value="created_asc">Oldest first</option>
            </Field>
          </div>
          <div className="workspace-list-rail">
            {filteredJobs.map((job) => (
              <button key={job.id} className={`workspace-nav-item ${selectedJob?.id === job.id ? 'selected' : ''}`} onClick={() => setSelectedJobId(job.id)}>
                <div className="workspace-nav-topline">
                  <div className="job-key-row">
                    <span className="job-key">{job.jiraKey || job.id}</span>
                    {renderSourceChip(job)}
                  </div>
                  <StateBadge state={job.state} />
                </div>
                <div className="workspace-nav-title">{job.title}</div>
                <div className="workspace-nav-meta-row">
                  <span className="workspace-nav-meta">{job.workflowLabel}</span>
                  <span className="workspace-nav-meta">{relativeTime(job.lastActivityAt)}</span>
                </div>
                <div className="chip-row compact-chip-row">
                  <WorkflowChip job={job} />
                  <EngineChip job={job} />
                </div>
                {job.pr ? (
                  <div className="workspace-pr-line">
                    <a className="workspace-pr-row" href={job.pr.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title={job.pr.checksTooltip || undefined}>
                      <GitPullRequest size={13} className={githubStatusClass(job.pr)} />
                      <span>{formatPrSummary(job)}</span>
                    </a>
                    {hasPrDiff(job.pr) ? (
                      <div className="pr-diff-summary workspace-pr-diff-summary">
                        <span className="pr-diff-added">+{job.pr.additions || 0}</span>
                        <span className="pr-diff-removed">-{job.pr.deletions || 0}</span>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section className="workspace-stream-pane">
          <div className="stream-pane-topbar">
            <div>
              <div className="eyebrow-row">Execution stream</div>
              <div className="stream-title">{selectedJob?.jiraKey || 'No workspace selected'} · {selectedJob?.title || ''}</div>
              {selectedJob?.manual ? <div className="stream-subtitle">Manual workspace, no Slack thread</div> : null}
            </div>
            <div className="stream-top-actions">
              {selectedJob ? (
                <details className="actions-menu">
                  <summary className="actions-menu-trigger">Actions</summary>
                  <div className="actions-menu-list">
                    <Button size="sm" onClick={async () => { const url = await ensureAiTerminal(selectedJob); setAiUrl(url || ''); setStreamError(''); }}><TerminalSquare size={14} /> Reattach</Button>
                    <Button size="sm" variant="secondary" onClick={() => void handleRefreshState(selectedJob)} disabled={Boolean(stateRefreshLoadingByJob[selectedJob.id])}><RotateCw size={14} /> {stateRefreshLoadingByJob[selectedJob.id] ? 'Refreshing…' : 'Refresh state'}</Button>
                    <Button size="sm" variant="secondary" onClick={async () => { await reconcileJob(selectedJob.id); await refresh(); }}><RefreshCw size={14} /> Reconcile</Button>
                    <Button size="sm" variant="ghost" onClick={async () => { await markJobStale(selectedJob.id, !selectedJob.operatorFlags.markedStaleAt); await refresh(); }}>{selectedJob.operatorFlags.markedStaleAt ? 'Clear stale' : 'Mark stale'}</Button>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      setAiUrl('');
                      const r = await openTerminal(selectedJob.id, true);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.actions.canCreateRecoveryShell}><Wrench size={14} /> Recover tmux</Button>
                    <Button size="sm" variant="secondary" onClick={async () => {
                      setAiUrl('');
                      const r = await recoverEngine(selectedJob.id);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.actions.canRecoverEngine}><Wrench size={14} /> Recover {selectedJob.engine.label}</Button>
                  </div>
                </details>
              ) : null}
            </div>
          </div>

          {streamError ? <AppCard className="stream-error-card">Execution stream unavailable: {streamError}</AppCard> : null}
          {selectedJob ? (aiUrl ? <iframe key={`desktop-ai-${selectedJob?.id || 'none'}-${aiUrl}`} className="workspace-stream-frame" src={aiUrl} title="ai-stream" /> : <TerminalPendingCard loading={Boolean(aiLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureAiTerminal(selectedJob); }}>{selectedJob.engine.terminalTitle}</TerminalPendingCard>) : <AppCard className="stream-placeholder">Open a workspace to attach to the execution stream.</AppCard>}
        </section>

        <aside className="workspace-side-pane">
          {selectedJob ? (
            <>
              <StateEvaluationCard job={selectedJob} />

              <AppCard className="side-top-card">
                <div className="overview-card-toprow">
                  <div>
                    <div className="section-title">Workspace overview</div>
                    <div className="decision-title">{nextActionLabel(selectedJob)}</div>
                    {selectedJob.manual ? <div className="job-key-row overview-source-row">{renderSourceChip(selectedJob)}</div> : null}
                  </div>
                  <div className="icon-links-row overview-icon-links">
                    {renderSlackButton(selectedJob)}
                    {selectedJob.jiraUrl ? <a className="icon-link-button jira-link-button" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer" title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                    <a className={`icon-link-button ${githubStatusClass(selectedJob.pr)}`} href={selectedJob.pr?.url || selectedJob.prUrl || '#'} target="_blank" rel="noreferrer" title={selectedJob.pr?.checksTooltip || (selectedJob.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { if (!selectedJob.pr && !selectedJob.prUrl) event.preventDefault(); }}>
                      <GitPullRequest size={15} />
                    </a>
                  </div>
                </div>
                {selectedJobPrLoading || selectedJobGitLoading || selectedJobDevLinksLoading ? <div className="muted">Loading workspace sections…</div> : null}
                <div className="decision-body">{topSignal(selectedJob)}</div>
                <div className="chip-row">
                  <WorkflowChip job={selectedJob} />
                  <EngineChip job={selectedJob} />
                </div>
                {hasPrDiff(selectedJob.pr) ? (
                  <div className="pr-diff-summary">
                    <span className="pr-diff-added">+{selectedJob.pr.additions || 0}</span>
                    <span className="pr-diff-removed">-{selectedJob.pr.deletions || 0}</span>
                  </div>
                ) : null}
              </AppCard>

              <AppCard className="side-top-card">
                <div className="overview-card-toprow">
                  <div className="section-title">Container links</div>
                  <Button size="sm" variant="secondary" onClick={() => void handleRedeployDev(selectedJob)} disabled={!selectedJob.worktreePath || Boolean(deployLoadingByJob[selectedJob.id])}>{deployLoadingByJob[selectedJob.id] ? 'Deploying…' : 'Redeploy'}</Button>
                </div>
                {selectedJob.devLinks?.length ? (
                  <div className="dev-links-grid">
                    {selectedJob.devLinks.map((link) => (
                      <a key={link.url} className="dev-link-chip" href={link.url} target="_blank" rel="noreferrer" title={link.healthy ? 'Container healthy' : 'Container unhealthy'}>
                        <Box size={12} className={link.healthy ? 'dev-link-healthy' : 'dev-link-unhealthy'} />
                        <span>{link.label}</span>
                      </a>
                    ))}
                  </div>
                ) : selectedJobDevLinksLoading ? <div className="muted">Loading container links…</div> : <div className="muted">No container links for this workspace yet.</div>}
              </AppCard>

              <AppCard className="side-top-card">
                <div className="overview-card-toprow">
                  <div className="section-title">PR stats</div>
                  <Button size="sm" variant="secondary" onClick={() => void handleRefreshPr(selectedJob)} disabled={!selectedJob.prUrl || Boolean(prRefreshLoadingByJob[selectedJob.id])}>{prRefreshLoadingByJob[selectedJob.id] ? 'Refreshing…' : 'Refresh'}</Button>
                </div>
                {selectedJob.pr ? (
                  <>
                    <a className="inline-link pr-link-block" href={selectedJob.pr.url} target="_blank" rel="noreferrer">
                      <GitPullRequest size={14} className={githubStatusClass(selectedJob.pr)} />
                      <span>{selectedJob.pr.title || `PR #${selectedJob.pr.number || selectedJob.prNumber}`}</span>
                    </a>
                    {selectedJob.pr.refreshedAt ? <div className="muted">Last refresh {relativeTime(selectedJob.pr.refreshedAt)}</div> : null}
                    {selectedJob.pr.checks?.length ? (
                      <div className="pr-checks-list">
                        {selectedJob.pr.checks.map((check) => (
                          <div key={`${check.name}:${check.status}`} className="pr-check-row">
                            <span className={`pr-check-status pr-check-status-${check.status.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}>{check.status}</span>
                            <span className="pr-check-name">{check.name}</span>
                          </div>
                        ))}
                      </div>
                    ) : selectedJobPrLoading ? <div className="muted">Loading PR checks…</div> : <div className="muted">No checks reported yet.</div>}
                  </>
                ) : selectedJobPrLoading ? <div className="muted">Loading PR details…</div> : <div className="muted">No PR linked yet.</div>}
              </AppCard>

              <AppCard className={selectedJob.gitStatus?.clean ? 'side-top-card git-status-clean-card' : 'side-top-card'}>
                <div className="section-title">Git status</div>
                {selectedJob.gitStatus ? (
                  <>
                    <div className="git-status-summary">
                      <span className={selectedJob.gitStatus.clean ? 'git-status-clean' : 'git-status-dirty'}>{selectedJob.gitStatus.clean ? 'clean' : 'dirty'}</span>
                      {selectedJob.gitStatus.ahead ? <span>ahead {selectedJob.gitStatus.ahead}</span> : null}
                      {selectedJob.gitStatus.behind ? <span>behind {selectedJob.gitStatus.behind}</span> : null}
                      {selectedJob.gitStatus.staged ? <span>{selectedJob.gitStatus.staged} staged</span> : null}
                      {selectedJob.gitStatus.modified ? <span>{selectedJob.gitStatus.modified} modified</span> : null}
                      {selectedJob.gitStatus.untracked ? <span>{selectedJob.gitStatus.untracked} untracked</span> : null}
                      {selectedJob.gitStatus.deleted ? <span>{selectedJob.gitStatus.deleted} deleted</span> : null}
                      {selectedJob.gitStatus.conflicted ? <span>{selectedJob.gitStatus.conflicted} conflicted</span> : null}
                    </div>
                    {selectedJob.gitStatus.clean ? <div className="muted">Working tree clean.</div> : (selectedJob.gitStatus.lines.length ? <pre>{selectedJob.gitStatus.lines.join('\n')}</pre> : <div className="muted">Git status unavailable.</div>)}
                  </>
                ) : selectedJobGitLoading ? <div className="muted">Loading git status…</div> : <div className="muted">Git status unavailable.</div>}
              </AppCard>

              <div className="right-bottom-terminal">
                {shellUrl ? <iframe key={`desktop-shell-${selectedJob.id}-${shellUrl}`} className="workspace-shell-frame" src={shellUrl} title="workspace-shell" /> : <TerminalPendingCard loading={Boolean(shellLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureShellTerminal(selectedJob); }}>Worktree terminal</TerminalPendingCard>}
              </div>
            </>
          ) : (
            <AppCard className="stream-placeholder">Select a workspace.</AppCard>
          )}
        </aside>
      </div>
    </div>
  );
}
