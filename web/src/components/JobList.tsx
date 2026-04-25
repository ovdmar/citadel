import { StateBadge } from './StateBadge';
import { formatTime, relativeTime } from '../lib';
import type { JobRecord } from '../types';

export function JobList({ jobs, selectedJobId, onSelect }: { jobs: JobRecord[]; selectedJobId?: string; onSelect: (job: JobRecord) => void }) {
  return (
    <div className="job-list">
      {jobs.map((job) => (
        <button key={job.id} className={`job-card ${selectedJobId === job.id ? 'selected' : ''}`} onClick={() => onSelect(job)}>
          <div className="job-card-top">
            <div>
              <div className="job-key">{job.jiraKey || job.id}</div>
              <div className="job-title">{job.title}</div>
            </div>
            <StateBadge state={job.state} />
          </div>
          <div className="job-meta-row">
            <span>{job.workflowLabel}</span>
            <span>{job.tmuxSession || 'no tmux'}</span>
            <span>{relativeTime(job.lastActivityAt)}</span>
          </div>
          <div className="job-tail">{job.statusDetail || job.lastTmuxTailExcerpt || job.stateReason}</div>
          <div className="job-meta-row muted">
            <span>Updated {formatTime(job.updatedAt)}</span>
            <span>{job.tmuxExists ? 'tmux live' : 'tmux missing'}</span>
          </div>
        </button>
      ))}
    </div>
  );
}
