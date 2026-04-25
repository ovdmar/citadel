import { ExternalLink, Filter, GitPullRequest, RefreshCw, TerminalSquare, Wrench } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AppCard, Button, Field, MetaRow, Surface } from '../components/ui';
import { StateBadge } from '../components/StateBadge';
import { nextActionLabel, priorityScore, topSignal } from '../components/ux';
import { loadJobs, markJobStale, openShell, openTerminal, reconcileJob, relativeTime } from '../lib';
import type { JobRecord } from '../types';

const workflowOrder = ['implementation', 'tech-plan', 'concept-lab'] as const;

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

export function CockpitPage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [error, setError] = useState<string>('');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>('list');
  const [aiUrl, setAiUrl] = useState('');
  const [shellUrl, setShellUrl] = useState('');
  const [streamError, setStreamError] = useState('');
  const isMobile = useIsMobile();

  const refresh = async () => {
    try {
      const response = await loadJobs();
      const ranked = [...response.jobs].sort((a, b) => priorityScore(b) - priorityScore(a));
      setJobs(ranked);
      setSelectedJobId((current) => current || ranked[0]?.id);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed_to_load_jobs');
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => window.clearInterval(timer);
  }, []);

  const filteredJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (workflowFilter !== 'all' && job.workflow !== workflowFilter) return false;
      if (stateFilter !== 'all' && job.state !== stateFilter) return false;
      return true;
    });
  }, [jobs, workflowFilter, stateFilter]);

  const selectedJob = filteredJobs.find((job) => job.id === selectedJobId) || filteredJobs[0];

  useEffect(() => {
    if (selectedJob && selectedJob.id !== selectedJobId) setSelectedJobId(selectedJob.id);
  }, [selectedJob, selectedJobId]);

  useEffect(() => {
    if (!selectedJob || isMobile) return;
    let cancelled = false;
    (async () => {
      try {
        const [stream, shell] = await Promise.all([
          openTerminal(selectedJob.id),
          selectedJob.worktreePath ? openShell(selectedJob.id) : Promise.resolve(null)
        ]);
        if (cancelled) return;
        setAiUrl(stream.terminal.url);
        setShellUrl(shell?.terminal.url || '');
        setStreamError('');
      } catch (err) {
        if (cancelled) return;
        setStreamError(err instanceof Error ? err.message : 'terminal_open_failed');
      }
    })();
    return () => { cancelled = true; };
  }, [selectedJob?.id, isMobile]);

  useEffect(() => {
    if (!isMobile) setMobileView('list');
  }, [isMobile]);

  if (isMobile) {
    return (
      <div className="page-shell jarvis-shell">
        <header className="cockpit-header-card">
          <div className="cockpit-title-block">
            <div className="eyebrow-row">Citadel mobile</div>
            <h2>{mobileView === 'detail' ? (selectedJob?.jiraKey || 'Workspace') : 'Workspaces'}</h2>
            <p>{filteredJobs.length} visible</p>
            {error ? <p className="error-text">{error}</p> : null}
          </div>
          {mobileView === 'detail' ? <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>Back</Button> : null}
        </header>

        {mobileView === 'list' ? (
          <div className="mobile-workspace-list">
            {filteredJobs.map((job) => (
              <button key={job.id} className="workspace-row" onClick={() => { setSelectedJobId(job.id); setMobileView('detail'); }}>
                <div>
                  <div className="job-key">{job.jiraKey || job.id}</div>
                  <div className="workspace-title">{job.title}</div>
                  <div className="workspace-subtle">{topSignal(job)}</div>
                </div>
                <StateBadge state={job.state} />
              </button>
            ))}
          </div>
        ) : selectedJob ? (
          <div className="mobile-detail-stack">
            <AppCard>
              <div className="section-title">Next action</div>
              <div className="decision-title">{nextActionLabel(selectedJob)}</div>
              <div className="decision-body">{topSignal(selectedJob)}</div>
            </AppCard>
            <AppCard>
              <div className="link-actions">
                {selectedJob.slack.permalink ? <a className="inline-link" href={selectedJob.slack.permalink} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Slack</a> : null}
                {selectedJob.jiraUrl ? <a className="inline-link" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Jira</a> : null}
                {selectedJob.prUrl ? <a className="inline-link" href={selectedJob.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> PR</a> : null}
              </div>
            </AppCard>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="page-shell jarvis-shell superset-shell">
      <div className="superset-layout">
        <aside className="workspace-nav-pane">
          <div className="workspace-nav-top">
            <div>
              <div className="eyebrow-row">Workspaces</div>
              <h2 className="workspace-pane-title">Active sessions</h2>
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
          </div>

          <div className="workspace-list-rail">
            {filteredJobs.map((job) => (
              <button key={job.id} className={`workspace-nav-item ${selectedJob?.id === job.id ? 'selected' : ''}`} onClick={() => setSelectedJobId(job.id)}>
                <div className="workspace-nav-topline">
                  <span className="job-key">{job.jiraKey || job.id}</span>
                  <StateBadge state={job.state} />
                </div>
                <div className="workspace-nav-title">{job.title}</div>
                <div className="workspace-nav-meta">{job.workflowLabel} · {relativeTime(job.lastActivityAt)}</div>
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
              {selectedJob ? <Button size="sm" onClick={async () => { const r = await openTerminal(selectedJob.id); setAiUrl(r.terminal.url); }}><TerminalSquare size={14} /> Reattach</Button> : null}
              {selectedJob ? <Button size="sm" variant="secondary" onClick={async () => { await reconcileJob(selectedJob.id); await refresh(); }}><RefreshCw size={14} /> Reconcile</Button> : null}
            </div>
          </div>

          {streamError ? <AppCard className="stream-error-card">AI stream unavailable: {streamError}</AppCard> : null}
          {aiUrl ? <iframe className="workspace-stream-frame" src={aiUrl} title="ai-stream" /> : <AppCard className="stream-placeholder">Open a workspace to attach to the AI stream.</AppCard>}
        </section>

        <aside className="workspace-side-pane">
          {selectedJob ? (
            <>
              <AppCard className="side-top-card">
                <div className="section-title">Workspace overview</div>
                <div className="decision-title">{nextActionLabel(selectedJob)}</div>
                <div className="decision-body">{topSignal(selectedJob)}</div>
                <div className="side-action-row">
                  <Button size="sm" variant="ghost" onClick={async () => { await markJobStale(selectedJob.id, !selectedJob.operatorFlags.markedStaleAt); await refresh(); }}>{selectedJob.operatorFlags.markedStaleAt ? 'Clear stale' : 'Mark stale'}</Button>
                  <Button size="sm" variant="secondary" onClick={async () => { const r = await openTerminal(selectedJob.id, true); setAiUrl(r.terminal.url); }} disabled={!selectedJob.actions.canCreateRecoveryShell}><Wrench size={14} /> Recover</Button>
                </div>
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">Links</div>
                <div className="link-actions link-actions-vertical">
                  {selectedJob.slack.permalink ? <a className="inline-link" href={selectedJob.slack.permalink} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Slack thread</a> : <span className="muted">Slack unavailable</span>}
                  {selectedJob.jiraUrl ? <a className="inline-link" href={selectedJob.jiraUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Jira issue</a> : null}
                  {selectedJob.prUrl ? <a className="inline-link" href={selectedJob.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Pull request</a> : null}
                </div>
              </AppCard>

              <AppCard className="side-top-card">
                <div className="section-title">PR stats</div>
                <div className="detail-grid detail-grid-compact compact-detail-grid">
                  <Surface><MetaRow label="PR" value={selectedJob.prNumber ? `#${selectedJob.prNumber}` : '—'} /></Surface>
                  <Surface><MetaRow label="State" value={selectedJob.state} /></Surface>
                  <Surface><MetaRow label="Branch" value={selectedJob.branchName || '—'} mono /></Surface>
                  <Surface><MetaRow label="Claude" value={selectedJob.claudeSessionId || '—'} mono /></Surface>
                </div>
              </AppCard>

              <div className="shell-pane-block">
                <div className="shell-pane-header">
                  <div>
                    <div className="section-title">Worktree shell</div>
                    <div className="shell-pane-subtitle">Manual commands inside {selectedJob.worktreePath || 'workspace'}</div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={async () => { const r = await openShell(selectedJob.id); setShellUrl(r.terminal.url); }}><TerminalSquare size={14} /> Open shell</Button>
                </div>
                {shellUrl ? <iframe className="workspace-shell-frame" src={shellUrl} title="workspace-shell" /> : <AppCard className="stream-placeholder">Shell not attached yet.</AppCard>}
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
