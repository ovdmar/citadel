import { Box, GitPullRequest, RefreshCw, TerminalSquare, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppCard, Button, Field, MetaRow, Surface } from '../components/ui';
import { StateBadge } from '../components/StateBadge';
import { nextActionLabel, priorityScore, topSignal } from '../components/ux';
import { loadJobs, markJobStale, openShell, openTerminal, reconcileJob, recoverClaude, relativeTime } from '../lib';
import type { JobRecord, PullRequestSummary } from '../types';

const workflowOrder = ['implementation', 'tech-plan', 'concept-lab'] as const;
const LAST_SELECTED_JOB_ID_KEY = 'citadel:last-selected-job-id';

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

type WarmupProgressState = {
  phase: 'idle' | 'ai' | 'shell' | 'done';
  done: number;
  total: number;
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

function WarmupProgress({ progress }: { progress: WarmupProgressState }) {
  if (progress.phase === 'idle') return null;
  const ratio = progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 100;
  const label = progress.phase === 'ai'
    ? 'Warming AI streams'
    : progress.phase === 'shell'
      ? 'Warming side terminals'
      : 'Terminal warmup complete';
  return (
    <div className="terminal-warmup-card">
      <div className="terminal-warmup-topline">
        <span>{label}</span>
        <span>{progress.total ? `${progress.done}/${progress.total}` : 'done'}</span>
      </div>
      <div className="terminal-warmup-bar">
        <div className="terminal-warmup-fill" style={{ width: `${ratio}%` }} />
      </div>
    </div>
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
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'created_desc' | 'created_asc'>('created_desc');
  const [error, setError] = useState<string>('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
  const [mobileDetailTab, setMobileDetailTab] = useState<'stream' | 'stats'>('stream');
  const [aiUrl, setAiUrl] = useState('');
  const [shellUrl, setShellUrl] = useState('');
  const [terminalUrls, setTerminalUrls] = useState<Record<string, string>>({});
  const [shellTerminalUrls, setShellTerminalUrls] = useState<Record<string, string>>({});
  const [aiLoadingByJob, setAiLoadingByJob] = useState<Record<string, boolean>>({});
  const [shellLoadingByJob, setShellLoadingByJob] = useState<Record<string, boolean>>({});
  const [warmupProgress, setWarmupProgress] = useState<WarmupProgressState>({ phase: 'idle', done: 0, total: 0 });
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
  const preloadGenerationRef = useRef(0);
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
      if (!silent && hasLoadedOnce) {
        finishLoading('Workspace list refreshed', `Loaded ${ranked.length} workspace${ranked.length === 1 ? '' : 's'}`);
      } else if (!ranked.length && !silent) {
        setHasLoadedOnce(true);
        finishLoading('Ready', 'No active workspaces right now');
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

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredJobs = useMemo(() => {
    const filtered = jobs.filter((job) => {
      if (workflowFilter !== 'all' && job.workflow !== workflowFilter) return false;
      if (stateFilter !== 'all' && job.state !== stateFilter) return false;
      return true;
    });
    return filtered.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return sortBy === 'created_asc' ? aTime - bTime : bTime - aTime;
    });
  }, [jobs, workflowFilter, stateFilter, sortBy]);

  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) || filteredJobs[0];

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
    showLoading(hasLoadedOnce ? 72 : 74, 'Attaching AI stream', selectedJob.jiraKey || selectedJob.title, !hasLoadedOnce && !cachedUrl);
    setAiUrl(cachedUrl || '');
    setStreamError('');
    if (cachedUrl) {
      setHasLoadedOnce(true);
      finishLoading('Ready', 'AI stream attached');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = await ensureAiTerminal(selectedJob);
        if (cancelled) return;
        setAiUrl(url || '');
        setStreamError('');
        setHasLoadedOnce(true);
        finishLoading('Ready', 'AI stream attached');
      } catch (err) {
        if (cancelled) return;
        setAiUrl('');
        setStreamError(err instanceof Error ? err.message : 'terminal_open_failed');
        setHasLoadedOnce(true);
        finishLoading('Workspace loaded', 'AI stream is unavailable right now');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedJob?.id, terminalUrls, hasLoadedOnce]);

  useEffect(() => {
    if (!selectedJob) {
      setShellUrl('');
      return;
    }
    setAiUrl(terminalUrls[selectedJob.id] || '');
    setShellUrl(shellTerminalUrls[selectedJob.id] || '');
  }, [selectedJob?.id, terminalUrls, shellTerminalUrls]);

  useEffect(() => {
    if (!selectedJob || !hasLoadedOnce || !jobs.length) return;
    const generation = ++preloadGenerationRef.current;
    const aiQueue = sortByCreatedAtDesc(jobs)
      .filter((job) => job.actions.canOpenTerminal)
      .filter((job) => job.id !== selectedJob.id)
      .filter((job) => !terminalUrls[job.id]);
    const shellQueue = sortByCreatedAtDesc(jobs)
      .filter((job) => Boolean(job.worktreePath))
      .filter((job) => !shellTerminalUrls[job.id]);

    let cancelled = false;
    (async () => {
      if (aiQueue.length) setWarmupProgress({ phase: 'ai', done: 0, total: aiQueue.length });
      let aiDone = 0;
      for (const job of aiQueue) {
        if (cancelled || generation !== preloadGenerationRef.current) return;
        try {
          await ensureAiTerminal(job);
        } catch {
          // best-effort warmup only
        } finally {
          aiDone += 1;
          if (!cancelled && generation === preloadGenerationRef.current) {
            setWarmupProgress({ phase: 'ai', done: aiDone, total: aiQueue.length });
          }
        }
      }

      if (cancelled || generation !== preloadGenerationRef.current) return;
      if (shellQueue.length) setWarmupProgress({ phase: 'shell', done: 0, total: shellQueue.length });
      let shellDone = 0;
      for (const job of shellQueue) {
        if (cancelled || generation !== preloadGenerationRef.current) return;
        try {
          await ensureShellTerminal(job);
        } catch {
          // best-effort warmup only
        } finally {
          shellDone += 1;
          if (!cancelled && generation === preloadGenerationRef.current) {
            setWarmupProgress({ phase: 'shell', done: shellDone, total: shellQueue.length });
          }
        }
      }

      if (!cancelled && generation === preloadGenerationRef.current) {
        setWarmupProgress({ phase: 'done', done: shellQueue.length || aiQueue.length ? Math.max(shellQueue.length, aiQueue.length) : 0, total: shellQueue.length || aiQueue.length ? Math.max(shellQueue.length, aiQueue.length) : 0 });
        window.setTimeout(() => {
          if (generation === preloadGenerationRef.current) setWarmupProgress({ phase: 'idle', done: 0, total: 0 });
        }, 1200);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedJob?.id, hasLoadedOnce, jobs, terminalUrls, shellTerminalUrls]);

  useEffect(() => {
    if (!isMobile) {
      setMobileView('list');
      setMobileFiltersOpen(false);
    }
  }, [isMobile]);

  useEffect(() => {
    if (mobileView === 'detail') setMobileDetailTab('stream');
  }, [selectedJob?.id, mobileView]);

  if (isMobile) {
    return (
      <div className="page-shell jarvis-shell mobile-citadel-shell">
        <LoadingHud phase={loadingPhase} />
        <header className={`cockpit-header-card mobile-header-card ${mobileView === 'detail' ? 'detail' : ''}`}>
          <div className="cockpit-title-block">
            <div className="eyebrow-row">Citadel mobile</div>
            <h2>{mobileView === 'detail' ? (selectedJob?.jiraKey || 'Workspace') : 'Workspaces'}</h2>
            <p>{mobileView === 'detail' ? (selectedJob?.title || 'Workspace detail') : `${filteredJobs.length} visible`}</p>
            {error ? <p className="error-text">{error}</p> : null}
          </div>
          <div className="mobile-header-actions">
            {mobileView === 'detail' ? <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>Back</Button> : null}
            <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
            {mobileView === 'list' ? <Button size="sm" variant="ghost" onClick={() => setMobileFiltersOpen((open) => !open)}>{mobileFiltersOpen ? 'Hide filters' : 'Filters'}</Button> : null}
          </div>
        </header>
        <WarmupProgress progress={warmupProgress} />

        {mobileView === 'list' ? (
          <>
            {mobileFiltersOpen ? (
              <div className="workspace-filters mobile-filters-card">
                <Field value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
                  <option value="all">All workflows</option>
                  {workflowOrder.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
                </Field>
                <Field value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
                  <option value="all">All states</option>
                  <option value="running">Running</option>
                  <option value="waiting_human">Waiting human</option>
                  <option value="waiting_review">Waiting review</option>
                  <option value="waiting_approval">Waiting approval</option>
                  <option value="stale">Stale</option>
                  <option value="broken_missing_tmux">Broken</option>
                  <option value="failed">Failed</option>
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
                    <div className="job-key">{job.jiraKey || job.id}</div>
                    <div className="workspace-title">{job.title}</div>
                    <div className="mobile-card-icons-row">
                      {job.slack.permalink ? <a className="icon-link-button slack-link-button" href={job.slack.permalink} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title="Slack thread"><SlackIcon className="brand-icon" /></a> : null}
                      {job.jiraUrl ? <a className="icon-link-button jira-link-button" href={job.jiraUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                      <a className={`icon-link-button ${githubStatusClass(job.pr)}`} href={job.pr?.url || job.prUrl || '#'} target="_blank" rel="noreferrer" title={job.pr?.checksTooltip || (job.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { event.stopPropagation(); if (!job.pr && !job.prUrl) event.preventDefault(); }}>
                        <GitPullRequest size={15} />
                      </a>
                      {job.pr && (job.pr.additions || job.pr.deletions) ? (
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
                    <div className="section-title">Claude terminal</div>
                    <div className="shell-pane-subtitle">Live session for this workspace</div>
                  </div>
                  <div className="mobile-terminal-actions">
                    {aiUrl ? <Button size="sm" variant="ghost" onClick={() => { window.location.href = aiUrl; }}>Open full screen</Button> : null}
                    <Button size="sm" variant="secondary" onClick={async () => { const url = await ensureAiTerminal(selectedJob); setAiUrl(url || ''); setStreamError(''); }}><TerminalSquare size={14} /> Reattach</Button>
                  </div>
                </div>
                {streamError ? <AppCard className="stream-error-card">AI stream unavailable: {streamError}</AppCard> : null}
                {aiUrl ? <iframe key={`mobile-ai-${selectedJob.id}-${aiUrl}`} className="mobile-terminal-frame mobile-terminal-frame-large" src={aiUrl} title="mobile-ai-stream" /> : <TerminalPendingCard loading={Boolean(aiLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureAiTerminal(selectedJob); }}>Claude terminal</TerminalPendingCard>}
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
                  </div>
                  <div className="icon-links-row overview-icon-links mobile-overview-icons">
                    {selectedJob.slack.permalink ? <a className="icon-link-button slack-link-button" href={selectedJob.slack.permalink} target="_blank" rel="noreferrer" title="Slack thread"><SlackIcon className="brand-icon" /></a> : null}
                    {selectedJob.jiraUrl ? <a className="icon-link-button jira-link-button" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer" title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                    <a className={`icon-link-button ${githubStatusClass(selectedJob.pr)}`} href={selectedJob.pr?.url || selectedJob.prUrl || '#'} target="_blank" rel="noreferrer" title={selectedJob.pr?.checksTooltip || (selectedJob.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { if (!selectedJob.pr && !selectedJob.prUrl) event.preventDefault(); }}>
                      <GitPullRequest size={15} />
                    </a>
                    {selectedJob.pr && (selectedJob.pr.additions || selectedJob.pr.deletions) ? (
                      <div className="pr-diff-summary mobile-pr-diff-summary">
                        <span className="pr-diff-added">+{selectedJob.pr.additions || 0}</span>
                        <span className="pr-diff-removed">-{selectedJob.pr.deletions || 0}</span>
                      </div>
                    ) : null}
                  </div>
                  <div className="side-action-row">
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
                      const r = await recoverClaude(selectedJob.id);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.claudeSessionId}><Wrench size={14} /> Recover Claude</Button>
                  </div>
                </AppCard>

                {selectedJob.devLinks?.length ? (
                  <AppCard>
                    <div className="section-title">Container links</div>
                    <div className="dev-links-grid">
                      {selectedJob.devLinks.map((link) => (
                        <a key={link.url} className="dev-link-chip" href={link.url} target="_blank" rel="noreferrer" title={link.healthy ? 'Container healthy' : 'Container unhealthy'}>
                          <Box size={12} className={link.healthy ? 'dev-link-healthy' : 'dev-link-unhealthy'} />
                          <span>{link.label}</span>
                        </a>
                      ))}
                    </div>
                  </AppCard>
                ) : null}

                <AppCard>
                  <div className="section-title">Workspace stats</div>
                  <div className="detail-grid compact-detail-grid">
                    <Surface><MetaRow label="Claude" value={selectedJob.claudeSessionId || '—'} mono /></Surface>
                    <Surface><MetaRow label="Branch" value={selectedJob.branchName || selectedJob.gitStatus?.branch || '—'} mono /></Surface>
                    <Surface><MetaRow label="PR" value={selectedJob.pr?.number ? `#${selectedJob.pr.number}` : (selectedJob.prNumber ? `#${selectedJob.prNumber}` : '—')} /></Surface>
                    <Surface><MetaRow label="State" value={selectedJob.state} /></Surface>
                  </div>
                </AppCard>

                {selectedJob.pr ? (
                  <AppCard>
                    <div className="section-title">Pull request</div>
                    <a className="inline-link pr-link-block" href={selectedJob.pr.url} target="_blank" rel="noreferrer">
                      <GitPullRequest size={14} className={githubStatusClass(selectedJob.pr)} />
                      <span>{selectedJob.pr.title || `PR #${selectedJob.pr.number || selectedJob.prNumber}`}</span>
                    </a>
                    <div className="mobile-meta-list">
                      {selectedJob.pr.number ? <span>#{selectedJob.pr.number}</span> : null}
                      {selectedJob.pr.state ? <span>{selectedJob.pr.state.toLowerCase()}</span> : null}
                      {selectedJob.pr.reviewDecision ? <span>{selectedJob.pr.reviewDecision.toLowerCase()}</span> : null}
                      {selectedJob.pr.isDraft ? <span>draft</span> : null}
                    </div>
                    {selectedJob.pr.checksSummary ? <div className="decision-body compact-body">Checks: {selectedJob.pr.checksSummary}</div> : null}
                  </AppCard>
                ) : null}

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
      <div className="superset-layout">
        <aside className="workspace-nav-pane">
          <div className="workspace-nav-top">
            <div>
              <div className="eyebrow-row">Workspaces</div>
              <h2 className="workspace-pane-title">Active agents</h2>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
          </div>

          <div className="workspace-filters">
            <Field value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
              <option value="all">All workflows</option>
              {workflowOrder.map((workflow) => <option key={workflow} value={workflow}>{workflow}</option>)}
            </Field>
            <Field value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
              <option value="all">All states</option>
              <option value="running">Running</option>
              <option value="waiting_human">Waiting human</option>
              <option value="waiting_review">Waiting review</option>
              <option value="waiting_approval">Waiting approval</option>
              <option value="stale">Stale</option>
              <option value="broken_missing_tmux">Broken</option>
              <option value="failed">Failed</option>
            </Field>
            <Field value={sortBy} onChange={(e) => setSortBy(e.target.value as 'created_desc' | 'created_asc')}>
              <option value="created_desc">Newest first</option>
              <option value="created_asc">Oldest first</option>
            </Field>
          </div>
          <WarmupProgress progress={warmupProgress} />

          <div className="workspace-list-rail">
            {filteredJobs.map((job) => (
              <button key={job.id} className={`workspace-nav-item ${selectedJob?.id === job.id ? 'selected' : ''}`} onClick={() => setSelectedJobId(job.id)}>
                <div className="workspace-nav-topline">
                  <span className="job-key">{job.jiraKey || job.id}</span>
                  <StateBadge state={job.state} />
                </div>
                <div className="workspace-nav-title">{job.title}</div>
                <div className="workspace-nav-meta">{job.workflowLabel} · {relativeTime(job.lastActivityAt)}</div>
                {job.pr ? (
                  <a className="workspace-pr-row" href={job.pr.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()} title={job.pr.checksTooltip || undefined}>
                    <GitPullRequest size={13} className={githubStatusClass(job.pr)} />
                    <span>{formatPrSummary(job)}</span>
                  </a>
                ) : null}
              </button>
            ))}
          </div>
        </aside>

        <section className="workspace-stream-pane">
          <div className="stream-pane-topbar">
            <div>
              <div className="eyebrow-row">AI stream</div>
              <div className="stream-title">{selectedJob?.jiraKey || 'No workspace selected'} · {selectedJob?.title || ''}</div>
            </div>
            <div className="stream-top-actions">
              {selectedJob ? (
                <details className="actions-menu">
                  <summary className="actions-menu-trigger">Actions</summary>
                  <div className="actions-menu-list">
                    <Button size="sm" onClick={async () => { const url = await ensureAiTerminal(selectedJob); setAiUrl(url || ''); setStreamError(''); }}><TerminalSquare size={14} /> Reattach</Button>
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
                      const r = await recoverClaude(selectedJob.id);
                      setTerminalUrls((current) => ({ ...current, [selectedJob.id]: r.terminal.url }));
                      setAiUrl(r.terminal.url);
                      setStreamError('');
                    }} disabled={!selectedJob.claudeSessionId}><Wrench size={14} /> Recover Claude</Button>
                  </div>
                </details>
              ) : null}
            </div>
          </div>

          {streamError ? <AppCard className="stream-error-card">AI stream unavailable: {streamError}</AppCard> : null}
          {selectedJob ? (aiUrl ? <iframe key={`desktop-ai-${selectedJob?.id || 'none'}-${aiUrl}`} className="workspace-stream-frame" src={aiUrl} title="ai-stream" /> : <TerminalPendingCard loading={Boolean(aiLoadingByJob[selectedJob.id])} onLoadNow={async () => { await ensureAiTerminal(selectedJob); }}>Claude terminal</TerminalPendingCard>) : <AppCard className="stream-placeholder">Open a workspace to attach to the AI stream.</AppCard>}
        </section>

        <aside className="workspace-side-pane">
          {selectedJob ? (
            <>
              <AppCard className="side-top-card">
                <div className="overview-card-toprow">
                  <div>
                    <div className="section-title">Workspace overview</div>
                    <div className="decision-title">{nextActionLabel(selectedJob)}</div>
                  </div>
                  <div className="icon-links-row overview-icon-links">
                    {selectedJob.slack.permalink ? <a className="icon-link-button slack-link-button" href={selectedJob.slack.permalink} target="_blank" rel="noreferrer" title="Slack thread"><SlackIcon className="brand-icon" /></a> : null}
                    {selectedJob.jiraUrl ? <a className="icon-link-button jira-link-button" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer" title="Jira issue"><JiraIcon className="brand-icon" /></a> : null}
                    <a className={`icon-link-button ${githubStatusClass(selectedJob.pr)}`} href={selectedJob.pr?.url || selectedJob.prUrl || '#'} target="_blank" rel="noreferrer" title={selectedJob.pr?.checksTooltip || (selectedJob.pr ? 'PR status unavailable' : 'No PR linked yet')} onClick={(event) => { if (!selectedJob.pr && !selectedJob.prUrl) event.preventDefault(); }}>
                      <GitPullRequest size={15} />
                    </a>
                  </div>
                </div>
                <div className="decision-body">{topSignal(selectedJob)}</div>
                {selectedJob.pr && (selectedJob.pr.additions || selectedJob.pr.deletions) ? (
                  <div className="pr-diff-summary">
                    <span className="pr-diff-added">+{selectedJob.pr.additions || 0}</span>
                    <span className="pr-diff-removed">-{selectedJob.pr.deletions || 0}</span>
                  </div>
                ) : null}
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">Container links</div>
                {selectedJob.devLinks?.length ? (
                  <div className="dev-links-grid">
                    {selectedJob.devLinks.map((link) => (
                      <a key={link.url} className="dev-link-chip" href={link.url} target="_blank" rel="noreferrer" title={link.healthy ? 'Container healthy' : 'Container unhealthy'}>
                        <Box size={12} className={link.healthy ? 'dev-link-healthy' : 'dev-link-unhealthy'} />
                        <span>{link.label}</span>
                      </a>
                    ))}
                  </div>
                ) : <div className="muted">No container links for this workspace.</div>}
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">PR stats</div>
                {selectedJob.pr ? (
                  <>
                    <a className="inline-link pr-link-block" href={selectedJob.pr.url} target="_blank" rel="noreferrer">
                      <GitPullRequest size={14} className={githubStatusClass(selectedJob.pr)} />
                      <span>{selectedJob.pr.title || `PR #${selectedJob.pr.number || selectedJob.prNumber}`}</span>
                    </a>
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
                ) : <div className="muted">Git status unavailable.</div>}
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
