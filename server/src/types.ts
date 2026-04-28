export type WorkflowKey = 'implementation' | 'tech-plan' | 'concept-lab';

export type JobState =
  | 'running'
  | 'waiting_human'
  | 'waiting_review'
  | 'waiting_approval'
  | 'conflicts'
  | 'ci_failed'
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

export interface PullRequestCheck {
  name: string;
  status: string;
}

export interface PullRequestSummary {
  url: string;
  number?: number;
  title?: string;
  state?: string;
  reviewDecision?: string;
  isDraft?: boolean;
  checksSummary?: string;
  checks?: PullRequestCheck[];
  checksState?: 'missing' | 'pending' | 'passing' | 'failing' | 'merged';
  checksTooltip?: string;
  additions?: number;
  deletions?: number;
  refreshedAt?: string;
}

export interface GitStatusSummary {
  branch?: string;
  ahead?: number;
  behind?: number;
  modified: number;
  staged: number;
  untracked: number;
  deleted: number;
  renamed: number;
  conflicted: number;
  clean: boolean;
  lines: string[];
}

export interface DevLink {
  label: string;
  url: string;
  healthy?: boolean;
}

export interface JobRecord {
  id: string;
  workflow: WorkflowKey;
  workflowLabel: string;
  channelId: string;
  source: 'slack' | 'citadel_manual';
  sourceLabel: string;
  manual: boolean;
  hasSlackThread: boolean;
  startMode?: 'new' | 'existing_branch' | 'existing_pr';
  jiraKey?: string;
  title: string;
  jiraUrl?: string;
  prUrl?: string;
  prNumber?: number;
  pr?: PullRequestSummary;
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
  gitStatus?: GitStatusSummary;
  devLinks?: DevLink[];
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
  stateEvaluation?: StateEvaluation;
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
  kind: 'tmux' | 'shell' | 'claude' | 'command';
}

export interface CronJobRecord {
  id: string;
  agentId?: string;
  sessionKey?: string;
  name?: string;
  description?: string;
  enabled: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule: {
    kind?: 'at' | 'every' | 'cron';
    at?: string;
    everyMs?: number;
    anchorMs?: number;
    expr?: string;
    tz?: string;
    [key: string]: unknown;
  };
  sessionTarget?: string;
  wakeMode?: 'now' | 'next-heartbeat';
  payload?: {
    kind?: 'systemEvent' | 'agentTurn';
    text?: string;
    message?: string;
    timeoutSeconds?: number;
    thinking?: string;
    [key: string]: unknown;
  };
  delivery?: {
    mode?: string;
    channel?: string;
    to?: string;
    bestEffort?: boolean;
    [key: string]: unknown;
  };
  failureAlert?: {
    after?: number;
    mode?: string;
    channel?: string;
    to?: string;
    cooldownMs?: number;
    [key: string]: unknown;
  };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: string;
    lastStatus?: string;
    lastDurationMs?: number;
    lastDelivered?: boolean;
    lastDeliveryStatus?: string;
    consecutiveErrors?: number;
    [key: string]: unknown;
  };
  scheduleLabel?: string;
  health?: 'healthy' | 'failing' | 'disabled' | 'pending' | 'completed';
  nextRunAt?: string;
  lastRunAt?: string;
}

export interface CronRunEntry {
  ts: number;
  jobId: string;
  action?: string;
  status?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  delivered?: boolean;
  deliveryStatus?: string;
  sessionId?: string;
  sessionKey?: string;
  usage?: Record<string, number>;
}


export interface StateEvaluation {
  finalState: string;
  finalReason: string;
  source?: string;
  classifierState?: string;
  classifierReason?: string;
  classifierQuestion?: string;
  prChecksStatus?: string;
  reviewVerdict?: string;
  reviewReason?: string;
  feedbackPendingReview?: boolean;
  lastSentAction?: string;
  lastSentAt?: string;
  lastInboundClassification?: string;
  lastInboundReplyAt?: string;
  lastActivityAt?: string;
}
