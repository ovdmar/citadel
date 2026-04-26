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
  workflow: 'implementation' | 'tech-plan' | 'concept-lab';
  workflowLabel: string;
  channelId: string;
  jiraKey?: string;
  title: string;
  jiraUrl?: string;
  prUrl?: string;
  prNumber?: number;
  pr?: PullRequestSummary;
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
  kind: 'tmux' | 'shell' | 'claude' | 'command';
}

export interface CronRecord {
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


export interface OpenClawStats {
  runtimeVersion?: string;
  gateway: {
    url?: string;
    reachable?: boolean;
    latencyMs?: number;
    serviceInstalled?: boolean;
    serviceLoaded?: boolean;
    serviceRunning?: boolean;
    pid?: number;
  };
  sessions: {
    count: number;
    recent: Array<{ key?: string; updatedAt?: number; model?: string }>;
    defaultModel?: string;
    contextTokens?: number;
  };
  agents: {
    count: number;
    items: Array<{ agentId?: string; enabled?: boolean }>;
  };
  memory: {
    chunkCount: number;
    sourceCount: number;
    plugin?: string;
  };
  tasks: {
    active: number;
    total: number;
    failures: number;
    queued: number;
    running: number;
  };
  channels: Array<{
    label?: string;
    enabled?: boolean;
    state?: string;
    detail?: string;
  }>;
  citadel: {
    jobs: number;
    crons: number;
    terminals: number;
  };
}
