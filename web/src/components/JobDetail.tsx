import { ArrowLeft, BadgeCheck, Bot, ExternalLink, FolderTree, RefreshCw, TerminalSquare, Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatTime, markJobStale, openTerminal, reconcileJob } from '../lib';
import type { JobRecord } from '../types';
import { StateBadge } from './StateBadge';
import { AppCard, Button, MetaRow, Surface } from './ui';

export function JobDetail({ job, onChanged, onBack }: { job?: JobRecord; onChanged: () => Promise<void>; onBack?: () => void }) {
  const navigate = useNavigate();

  if (!job) {
    return <section className="detail-stack"><AppCard className="detail-empty">Pick a job to inspect it.</AppCard></section>;
  }

  const handleOpenTerminal = async (recovery = false) => {
    const response = await openTerminal(job.id, recovery);
    navigate(`/terminal?job=${encodeURIComponent(job.id)}&url=${encodeURIComponent(response.terminal.url)}`);
  };

  return (
    <section className="detail-stack">
      <AppCard className="hero-card">
        <div className="hero-topline">
          {onBack ? (
            <Button variant="ghost" size="sm" className="back-chip" onClick={onBack}>
              <ArrowLeft size={14} /> Jobs
            </Button>
          ) : <span className="hero-eyebrow">{job.workflowLabel}</span>}
          <StateBadge state={job.state} />
        </div>
        <div className="hero-key">{job.jiraKey || job.id}</div>
        <div className="hero-title">{job.title}</div>
        <div className="hero-subgrid">
          <span><Bot size={14} /> {job.claudeSessionId || 'no Claude id yet'}</span>
          <span><TerminalSquare size={14} /> {job.tmuxSession || 'no tmux'}</span>
          <span><BadgeCheck size={14} /> {job.stateReason}</span>
        </div>
      </AppCard>

      <div className="action-cluster">
        <Button size="sm" onClick={() => handleOpenTerminal(false)} disabled={!job.actions.canOpenTerminal}><TerminalSquare size={14} /> Terminal</Button>
        <Button size="sm" variant="secondary" onClick={() => handleOpenTerminal(true)} disabled={!job.actions.canCreateRecoveryShell}><Wrench size={14} /> Recover</Button>
        <Button size="sm" variant="secondary" onClick={async () => { await reconcileJob(job.id); await onChanged(); }}><RefreshCw size={14} /> Reconcile</Button>
        <Button size="sm" variant={job.operatorFlags.markedStaleAt ? 'danger' : 'ghost'} onClick={async () => { await markJobStale(job.id, !job.operatorFlags.markedStaleAt); await onChanged(); }}>{job.operatorFlags.markedStaleAt ? 'Clear stale' : 'Mark stale'}</Button>
      </div>

      <div className="detail-grid detail-grid-compact">
        <Surface><MetaRow label="Updated" value={formatTime(job.updatedAt)} /></Surface>
        <Surface><MetaRow label="Created" value={formatTime(job.createdAt)} /></Surface>
        <Surface><MetaRow label="Branch" value={job.branchName || '—'} mono /></Surface>
        <Surface><MetaRow label="Plan" value={job.planPath || '—'} mono /></Surface>
        <Surface><MetaRow label="Worktree" value={job.worktreePath || '—'} mono /></Surface>
        <Surface><MetaRow label="Transcript" value={job.transcriptPath || '—'} mono /></Surface>
      </div>

      <AppCard className="link-card">
        <div className="section-title">Quick links</div>
        <div className="link-actions">
          {job.slack.permalink ? <a className="inline-link" href={job.slack.permalink} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Slack thread</a> : <span className="muted">Slack unavailable</span>}
          {job.jiraUrl ? <a className="inline-link" href={job.jiraUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Jira</a> : null}
          {job.prUrl ? <a className="inline-link" href={job.prUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> PR</a> : null}
        </div>
      </AppCard>

      <AppCard className="info-card">
        <div className="section-title">Starter message</div>
        <pre>{job.slack.starterMessage || job.slack.error || 'No starter message available.'}</pre>
      </AppCard>

      <AppCard className="info-card">
        <div className="section-title">Live terminal snapshot</div>
        <pre>{job.lastTmuxTailExcerpt || 'No tmux tail captured.'}</pre>
      </AppCard>

      {job.statusDetail ? (
        <AppCard className="info-card">
          <div className="section-title">Operator detail</div>
          <pre>{job.statusDetail}</pre>
        </AppCard>
      ) : null}
    </section>
  );
}
