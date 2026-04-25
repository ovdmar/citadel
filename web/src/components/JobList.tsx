import { ArrowUpRight, Clock3, Cpu, Workflow } from 'lucide-react';
import { relativeTime } from '../lib';
import type { JobRecord } from '../types';
import { StateBadge } from './StateBadge';
import { AppCard } from './ui';

export function JobList({ jobs, selectedJobId, onSelect }: { jobs: JobRecord[]; selectedJobId?: string; onSelect: (job: JobRecord) => void }) {
  if (jobs.length === 0) {
    return <div className="empty-list-state">No jobs match the current filters.</div>;
  }

  return (
    <div className="job-list">
      {jobs.map((job) => (
        <button key={job.id} className={`job-tile ${selectedJobId === job.id ? 'selected' : ''}`} onClick={() => onSelect(job)}>
          <AppCard className="job-card">
            <div className="job-card-head">
              <div className="job-title-block">
                <div className="job-key-row">
                  <span className="job-key">{job.jiraKey || job.id}</span>
                  <StateBadge state={job.state} />
                </div>
                <div className="job-title">{job.title}</div>
              </div>
              <ArrowUpRight size={15} className="job-go" />
            </div>

            <div className="job-signal-row">
              <span><Workflow size={13} /> {job.workflowLabel}</span>
              <span><Clock3 size={13} /> {relativeTime(job.lastActivityAt)}</span>
              <span><Cpu size={13} /> {job.tmuxExists ? 'tmux live' : 'tmux missing'}</span>
            </div>

            <div className="job-snapshot">{job.statusDetail || job.lastTmuxTailExcerpt || job.stateReason}</div>

            <div className="job-footer-row">
              <span className="mono compact">{job.tmuxSession || 'no tmux'}</span>
            </div>
          </AppCard>
        </button>
      ))}
    </div>
  );
}
