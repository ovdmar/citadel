import { useNavigate } from 'react-router-dom';
import { formatTime, markJobStale, openTerminal, reconcileJob } from '../lib';
import type { JobRecord } from '../types';
import { StateBadge } from './StateBadge';

export function JobDetail({ job, onChanged }: { job?: JobRecord; onChanged: () => Promise<void> }) {
  const navigate = useNavigate();

  if (!job) {
    return <section className="detail-panel empty">Pick a job to inspect it.</section>;
  }

  const handleOpenTerminal = async (recovery = false) => {
    const response = await openTerminal(job.id, recovery);
    navigate(`/terminal?job=${encodeURIComponent(job.id)}&url=${encodeURIComponent(response.terminal.url)}`);
  };

  return (
    <section className="detail-panel">
      <div className="detail-header">
        <div>
          <div className="detail-eyebrow">{job.workflowLabel}</div>
          <h2>{job.jiraKey || job.id}</h2>
          <p>{job.title}</p>
        </div>
        <StateBadge state={job.state} />
      </div>

      <div className="action-row">
        <button onClick={() => handleOpenTerminal(false)} disabled={!job.actions.canOpenTerminal}>Open terminal</button>
        <button onClick={() => handleOpenTerminal(true)} disabled={!job.actions.canCreateRecoveryShell}>Create recovery shell</button>
        <button onClick={async () => { await reconcileJob(job.id); await onChanged(); }}>Reconcile now</button>
        <button onClick={async () => { await markJobStale(job.id, !job.operatorFlags.markedStaleAt); await onChanged(); }}>
          {job.operatorFlags.markedStaleAt ? 'Clear stale mark' : 'Mark stale'}
        </button>
      </div>

      <div className="detail-grid">
        <DetailItem label="State" value={`${job.state} (${job.stateReason})`} />
        <DetailItem label="Updated" value={formatTime(job.updatedAt)} />
        <DetailItem label="Created" value={formatTime(job.createdAt)} />
        <DetailItem label="tmux" value={job.tmuxSession || '—'} mono />
        <DetailItem label="Branch" value={job.branchName || '—'} mono />
        <DetailItem label="Worktree" value={job.worktreePath || '—'} mono />
        <DetailItem label="Transcript" value={job.transcriptPath || '—'} mono />
        <DetailItem label="Plan" value={job.planPath || '—'} mono />
      </div>

      <div className="link-row">
        {job.slack.permalink ? <a href={job.slack.permalink} target="_blank" rel="noreferrer">Open Slack thread</a> : <span className="muted">Slack thread unavailable</span>}
        {job.jiraUrl ? <a href={job.jiraUrl} target="_blank" rel="noreferrer">Open Jira</a> : null}
        {job.prUrl ? <a href={job.prUrl} target="_blank" rel="noreferrer">Open PR</a> : null}
      </div>

      <div className="detail-section">
        <h3>Starter message</h3>
        <pre>{job.slack.starterMessage || job.slack.error || 'No starter message available.'}</pre>
      </div>

      <div className="detail-section">
        <h3>Latest terminal tail</h3>
        <pre>{job.lastTmuxTailExcerpt || 'No tmux tail captured.'}</pre>
      </div>

      {job.statusDetail ? (
        <div className="detail-section">
          <h3>Operator detail</h3>
          <pre>{job.statusDetail}</pre>
        </div>
      ) : null}
    </section>
  );
}

function DetailItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="detail-item">
      <div className="detail-item-label">{label}</div>
      <div className={mono ? 'mono' : undefined}>{value}</div>
    </div>
  );
}
