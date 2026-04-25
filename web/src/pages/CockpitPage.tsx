import { Activity, AlertTriangle, RefreshCw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { JobDetail } from '../components/JobDetail';
import { JobList } from '../components/JobList';
import { nextActionLabel, priorityScore, topSignal } from '../components/ux';
import { AppCard, Field, Button, KpiPill } from '../components/ui';
import { loadJobs } from '../lib';
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
  const isMobile = useIsMobile();

  const refresh = async () => {
    try {
      const response = await loadJobs();
      setJobs(response.jobs);
      setSelectedJobId((current) => current || response.jobs[0]?.id);
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
    if (!isMobile) setMobileView('list');
  }, [isMobile]);

  const counts = useMemo(() => ({
    running: filteredJobs.filter((job) => job.state === 'running').length,
    waiting: filteredJobs.filter((job) => ['waiting_human', 'waiting_review', 'waiting_approval'].includes(job.state)).length,
    broken: filteredJobs.filter((job) => ['broken_missing_tmux', 'failed', 'stale'].includes(job.state)).length,
  }), [filteredJobs]);

  const priorityJobs = useMemo(() => [...filteredJobs].sort((a, b) => priorityScore(b) - priorityScore(a)).slice(0, 3), [filteredJobs]);

  return (
    <div className="page-shell jarvis-shell">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><Sparkles size={14} /> Citadel operator mesh</div>
          <h2>{isMobile && mobileView === 'detail' ? (selectedJob?.jiraKey || 'Job detail') : 'Live agent mesh'}</h2>
          <p>{filteredJobs.length} visible jobs, {jobs.length} active total</p>
          {error ? <p className="error-text">Citadel could not load jobs: {error}</p> : null}
        </div>
        {isMobile && mobileView === 'detail' ? (
          <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>Back</Button>
        ) : (
          <div className="toolbar-row compact-toolbar">
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
            <Button size="sm" variant="secondary" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</Button>
          </div>
        )}
      </header>

      {(!isMobile || mobileView === 'list') && (
        <>
          <section className="kpi-strip">
            <KpiPill value={<><Activity size={15} /> {counts.running}</>} label="running" tone="accent" />
            <KpiPill value={<><Sparkles size={15} /> {counts.waiting}</>} label="waiting" tone="neutral" />
            <KpiPill value={<><AlertTriangle size={15} /> {counts.broken}</>} label="needs care" tone="danger" />
          </section>

          <section className="attention-lane">
            <div className="section-label">What needs attention first</div>
            <div className="attention-grid">
              {priorityJobs.map((job) => (
                <button
                  key={job.id}
                  className="attention-item"
                  onClick={() => {
                    setSelectedJobId(job.id);
                    if (isMobile) setMobileView('detail');
                  }}
                >
                  <AppCard className="attention-card">
                    <div className="attention-top">
                      <span className="job-key">{job.jiraKey || job.id}</span>
                      <span className={`state-pill state-pill-${job.state}`}>{job.state.replaceAll('_', ' ')}</span>
                    </div>
                    <div className="attention-title">{job.title}</div>
                    <div className="attention-signal">{topSignal(job)}</div>
                    <div className="attention-next">Next: {nextActionLabel(job)}</div>
                  </AppCard>
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <div className={`cockpit-layout ${isMobile ? 'mobile-mode' : ''}`}>
        {(!isMobile || mobileView === 'list') ? (
          <JobList
            jobs={filteredJobs}
            selectedJobId={selectedJob?.id}
            onSelect={(job) => {
              setSelectedJobId(job.id);
              if (isMobile) setMobileView('detail');
            }}
          />
        ) : null}
        {(!isMobile || mobileView === 'detail') ? (
          <JobDetail job={selectedJob} onChanged={refresh} onBack={isMobile ? () => setMobileView('list') : undefined} />
        ) : null}
      </div>
    </div>
  );
}
