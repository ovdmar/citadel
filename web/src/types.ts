export type JobState =
  | 'running'
  | 'waiting_human'
  | 'waiting_review'
  | 'waiting_approval'
  | 'idle'
  | 'stale'
  | 'broken_missing_tmux'
  | 'failed'
  | 'done'
  | 'unknown';

export interface JobRecord {
  id: string;
  workflow: 'implementation' | 'tech-plan' | 'concept-lab';
  workflowLabel: string;
  channelId: string;
  jiraKey?: string;
  title: string;
  jiraUrl?: string;
  prUrl?: string;
  prNumber?: number;
  slackThreadTs?: string;
  slack: {
    permalink?: string;
    starterMessage?: string;
    starterUser?: string;
    fetchedAt?: string;
    error?: string;
  };
  tmuxSession?: string;
  tmuxExists: boolean;
  worktreePath?: string;
  transcriptPath?: string;
  claudeSessionId?: string;
  planPath?: string;
  requestPath?: string;
  branchName?: string;
  createdAt?: string;
  updatedAt?: string;
  lastActivityAt?: string;
  lastTmuxTailExcerpt?: string;
  state: JobState;
  stateReason: string;
  stateSource?: string;
  statusDetail?: string;
  operatorFlags: {
    markedStaleAt?: string;
  };
  actions: {
    canReconcile: boolean;
    canCreateRecoveryShell: boolean;
    canOpenTerminal: boolean;
  };
  raw: Record<string, unknown>;
}

export interface TerminalRecord {
  key: string;
  tmuxSession?: string;
  worktreePath?: string;
  port: number;
  url: string;
  pid: number;
  createdAt: string;
  updatedAt: string;
  recoveryMode: boolean;
  kind: 'tmux' | 'shell';
}
