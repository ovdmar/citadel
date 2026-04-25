import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { loadJobs, loadTerminals, openTerminal } from '../lib';
import type { JobRecord } from '../types';

export function TerminalPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [url, setUrl] = useState(searchParams.get('url') || '');
  const [jobId, setJobId] = useState(searchParams.get('job') || '');

  useEffect(() => {
    void loadJobs().then((response) => setJobs(response.jobs));
    void loadTerminals().then((response) => {
      if (!url && response.terminals[0]) setUrl(response.terminals[0].url);
    });
  }, []);

  const selectedJob = jobs.find((job) => job.id === jobId) || jobs[0];

  useEffect(() => {
    if (selectedJob && !jobId) setJobId(selectedJob.id);
  }, [selectedJob, jobId]);

  const handleAttach = async () => {
    if (!selectedJob) return;
    const response = await openTerminal(selectedJob.id);
    setUrl(response.terminal.url);
    setJobId(selectedJob.id);
    setSearchParams({ job: selectedJob.id, url: response.terminal.url });
  };

  return (
    <div className="page-shell terminal-shell">
      <header className="page-header">
        <div>
          <h2>Terminal bridge</h2>
          <p>Jump straight into an agent tmux session.</p>
        </div>
        <div className="filters">
          <select value={selectedJob?.id || ''} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((job) => (
              <option value={job.id} key={job.id}>{job.jiraKey || job.id} · {job.tmuxSession || 'no tmux'} · {job.title}</option>
            ))}
          </select>
          <button onClick={() => void handleAttach()} disabled={!selectedJob}>Attach</button>
          <button onClick={() => navigate('/')}>Back to cockpit</button>
        </div>
      </header>

      <div className="terminal-info">
        <div><strong>Session:</strong> {selectedJob?.tmuxSession || '—'}</div>
        <div><strong>State:</strong> {selectedJob?.state || '—'}</div>
        <div><strong>Worktree:</strong> {selectedJob?.worktreePath || '—'}</div>
      </div>

      {url ? <iframe className="terminal-frame" src={url} title="tmux terminal" /> : <div className="terminal-empty">Open a session to start.</div>}
    </div>
  );
}
