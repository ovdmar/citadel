import { ArrowLeft, ExternalLink, RadioTower, TerminalSquare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Field, KpiPill, Surface } from '../components/ui';
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
    <div className="page-shell terminal-shell jarvis-shell">
      <header className="cockpit-header-card">
        <div className="cockpit-title-block">
          <div className="eyebrow-row"><TerminalSquare size={14} /> Terminal bridge</div>
          <h2>{selectedJob?.jiraKey || 'Session access'}</h2>
          <p>Low-friction browser access into the live execution terminal.</p>
        </div>
        <div className="toolbar-row compact-toolbar">
          <Button size="sm" variant="ghost" onClick={() => navigate('/')}><ArrowLeft size={14} /> Cockpit</Button>
          <Button size="sm" onClick={() => void handleAttach()} disabled={!selectedJob}><RadioTower size={14} /> Attach</Button>
        </div>
      </header>

      <section className="kpi-strip">
        <KpiPill value={<><TerminalSquare size={15} /> {selectedJob?.tmuxSession || '—'}</>} label="session" tone="neutral" />
        <KpiPill value={selectedJob?.state || '—'} label="state" tone="accent" />
      </section>

      <Surface className="terminal-toolbar-panel">
        <Field value={selectedJob?.id || ''} onChange={(e) => setJobId(e.target.value)}>
          {jobs.map((job) => (
            <option value={job.id} key={job.id}>{job.jiraKey || job.id} · {job.tmuxSession || 'no tmux'} · {job.title}</option>
          ))}
        </Field>
        {url ? <a className="inline-link" href={url}><ExternalLink size={14} /> Open raw terminal</a> : null}
      </Surface>

      <Surface className="terminal-info-grid">
        <div><strong>Terminal</strong><span>{selectedJob?.tmuxSession || '—'}</span></div>
        <div><strong>Engine</strong><span>{selectedJob ? `${selectedJob.engine.label} · ${selectedJob.engine.sessionId || '—'}` : '—'}</span></div>
        <div><strong>Worktree</strong><span>{selectedJob?.worktreePath || '—'}</span></div>
      </Surface>

      {url ? <iframe className="terminal-frame" src={url} title="tmux terminal" /> : <div className="terminal-empty">Open a session to start.</div>}
    </div>
  );
}
