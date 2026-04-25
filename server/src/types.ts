export type WorkflowKey = 'implementation' | 'tech-plan' | 'concept-lab';

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

export interface WorkflowConfig {
  key: WorkflowKey;
  label: string;
  channelId: string;
  stateDir: string;
  reconcileCommand: string[];
  classifyMode: 'implementation' | 'tech-plan' | 'concept-lab';
}

export interface SlackThreadSummary {
  permalink?: string;
  starterMessage?: string;
  starterUser?: string;
  fetchedAt?: string;
  error?: string;
}

export interface OperatorFlags {
  markedStaleAt?: string;
}

export interface JobRecord {
  id: string;
  workflow: WorkflowKey;
  workflowLabel: string;
  channelId: string;
  jiraKey?: string;
  title: string;
  jiraUrl?: string;
  prUrl?: string;
  prNumber?: number;
  slackThreadTs?: string;
  slack: SlackThreadSummary;
  tmuxSession?: string;
  tmuxExists: boolean;
  tmuxWindow?: string;
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
  operatorFlags: OperatorFlags;
  actions: {
    canReconcile: boolean;
    canCreateRecoveryShell: boolean;
    canOpenTerminal: boolean;
  };
  raw: Record<string, unknown>;
}

export interface TerminalSessionRecord {
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
