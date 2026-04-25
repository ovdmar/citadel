import { useEffect, useMemo, useState } from 'react';
import { JobDetail } from '../components/JobDetail';
import { JobList } from '../components/JobList';
import { loadJobs } from '../lib';
import type { JobRecord } from '../types';

const workflowOrder = ['implementation', 'tech-plan', 'concept-lab'] as const;

export function CockpitPage() {
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string>();
  const [workflowFilter, setWorkflowFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<string>('all');
  const [error, setError] = useState<string>('');

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

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <h2>Open jobs</h2>
          <p>{jobs.length} active jobs across 3 workflows</p>
          {error ? <p className="error-text">Citadel could not load jobs: {error}</p> : null}
        </div>
        <div className="filters">
          <select value={workflowFilter} onChange={(e) => setWorkflowFilter(e.target.value)}>
            <option value="all">All workflows</option>
            {workflowOrder.map((workflow) => (
              <option key={workflow} value={workflow}>{workflow}</option>
            ))}
          </select>
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)}>
            <option value="all">All states</option>
            <option value="running">running</option>
            <option value="waiting_human">waiting human</option>
            <option value="waiting_review">waiting review</option>
            <option value="waiting_approval">waiting approval</option>
            <option value="stale">stale</option>
            <option value="broken_missing_tmux">broken</option>
            <option value="failed">failed</option>
          </select>
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
      </header>

      <div className="cockpit-layout">
        <JobList jobs={filteredJobs} selectedJobId={selectedJob?.id} onSelect={(job) => setSelectedJobId(job.id)} />
        <JobDetail job={selectedJob} onChanged={refresh} />
      </div>
    </div>
  );
}
