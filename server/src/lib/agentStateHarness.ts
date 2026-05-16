export type HarnessRuntimeEvidence = {
  tmuxSessionExists?: boolean;
  processAlive?: boolean;
  backgroundActivity?: boolean;
  monitorActivity?: boolean;
  sessionResumable?: boolean;
  recoveryShellAvailable?: boolean;
  lastActivityAt?: string;
  failureKind?: 'none' | 'tmux_missing' | 'session_dead' | 'process_crashed' | 'unknown';
  failureDetail?: string;
};

export type HarnessInteractionEvidence = {
  openQuestions?: string[];
  awaitingHumanAnswer?: boolean;
  awaitingMerge?: boolean;
};

export type HarnessWorkflowEvidence = {
  reviewCompleted?: boolean;
  reviewApproved?: boolean;
  findingsResolved?: boolean;
  branchPushed?: boolean;
  worktreeClean?: boolean;
  prExists?: boolean;
  ciGreen?: boolean;
  hasMergeConflicts?: boolean;
  prMergeable?: boolean;
  endStateReached?: boolean;
};

export type HarnessResumeEvidence = {
  blockReason?: 'none' | 'usage_limit' | 'temp_rate_limit' | 'poke_budget_exhausted';
  resetAt?: string;
  consecutivePokes?: number;
  maxConsecutivePokes?: number;
  lastPokeAt?: string;
};

export type HarnessEvidence = {
  runtime?: HarnessRuntimeEvidence;
  interaction?: HarnessInteractionEvidence;
  workflow?: HarnessWorkflowEvidence;
  resume?: HarnessResumeEvidence;
  now?: string;
};

export type NormalizedHarnessFacts = {
  runtime: {
    isRunning: boolean;
    isRecoverable: boolean;
    isBroken: boolean;
    failureKind: HarnessRuntimeEvidence['failureKind'];
    failureDetail?: string;
    tmuxSessionExists: boolean;
    processAlive: boolean;
    backgroundActivity: boolean;
    monitorActivity: boolean;
    sessionResumable: boolean;
    recoveryShellAvailable: boolean;
    lastActivityAt?: string;
  };
  interaction: {
    openQuestions: string[];
    awaitingHumanAnswer: boolean;
    awaitingMerge: boolean;
    needsHumanInput: boolean;
  };
  workflow: {
    reviewCompleted: boolean;
    reviewApproved: boolean;
    findingsResolved: boolean;
    branchPushed: boolean;
    worktreeClean: boolean;
    prExists: boolean;
    ciGreen: boolean;
    hasMergeConflicts: boolean;
    prMergeable: boolean;
    endStateReached: boolean;
    readyForMerge: boolean;
    incomplete: boolean;
  };
  resume: {
    blockReason: NonNullable<HarnessResumeEvidence['blockReason']>;
    resetAt?: string;
    resetPassed: boolean;
    consecutivePokes: number;
    maxConsecutivePokes: number;
    pokeBudgetExhausted: boolean;
    canPokeNow: boolean;
    shouldWaitForReset: boolean;
    tempRateLimited: boolean;
  };
};

export type DominantAgentState =
  | 'running'
  | 'needs_reply'
  | 'needs_poke'
  | 'waiting_reset'
  | 'ready_to_merge'
  | 'broken'
  | 'deferred_to_human'
  | 'done';

export type CardView = {
  badge: 'Running' | 'Needs reply' | 'Needs poke' | 'Waiting reset' | 'Ready to merge' | 'Broken' | 'Deferred' | 'Done';
  subline: string;
  action: 'none' | 'reply' | 'poke' | 'recover' | 'merge' | 'review';
};

export type HarnessEvaluation = {
  facts: NormalizedHarnessFacts;
  dominantState: DominantAgentState;
  reason: string;
  explanationPath: string[];
  card: CardView;
};

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatClock(value?: string): string {
  if (!value) return 'unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Bucharest',
  }).format(date);
}

export function normalizeHarnessFacts(evidence: HarnessEvidence): NormalizedHarnessFacts {
  const runtime = evidence.runtime ?? {};
  const interaction = evidence.interaction ?? {};
  const workflow = evidence.workflow ?? {};
  const resume = evidence.resume ?? {};
  const now = parseTime(evidence.now) ?? Date.now();

  const openQuestions = (interaction.openQuestions ?? []).filter(Boolean);
  const consecutivePokes = Math.max(0, resume.consecutivePokes ?? 0);
  const maxConsecutivePokes = Math.max(1, resume.maxConsecutivePokes ?? 3);
  const resetAt = parseTime(resume.resetAt);
  const resetPassed = resetAt !== undefined ? now >= resetAt : false;
  const blockReason = resume.blockReason ?? 'none';
  const pokeBudgetExhausted = blockReason === 'poke_budget_exhausted' || consecutivePokes >= maxConsecutivePokes;
  const shouldWaitForReset = blockReason === 'usage_limit' && !resetPassed;
  const tempRateLimited = blockReason === 'temp_rate_limit';
  const canPokeNow = !pokeBudgetExhausted && (blockReason === 'none' || tempRateLimited || (blockReason === 'usage_limit' && resetPassed));

  const readyForMerge = Boolean(
    workflow.reviewCompleted
      && workflow.reviewApproved
      && workflow.findingsResolved
      && workflow.branchPushed
      && workflow.worktreeClean
      && workflow.prExists
      && workflow.ciGreen
      && workflow.prMergeable
      && !workflow.hasMergeConflicts
      && !workflow.endStateReached
  );

  const isRunning = Boolean(runtime.processAlive || runtime.backgroundActivity || runtime.monitorActivity);
  const isRecoverable = Boolean(runtime.tmuxSessionExists || runtime.sessionResumable || runtime.recoveryShellAvailable);
  const failureKind = runtime.failureKind ?? 'none';
  const isBroken = !isRunning && failureKind !== 'none' && !isRecoverable;

  return {
    runtime: {
      isRunning,
      isRecoverable,
      isBroken,
      failureKind,
      failureDetail: runtime.failureDetail,
      tmuxSessionExists: Boolean(runtime.tmuxSessionExists),
      processAlive: Boolean(runtime.processAlive),
      backgroundActivity: Boolean(runtime.backgroundActivity),
      monitorActivity: Boolean(runtime.monitorActivity),
      sessionResumable: Boolean(runtime.sessionResumable),
      recoveryShellAvailable: Boolean(runtime.recoveryShellAvailable),
      lastActivityAt: runtime.lastActivityAt,
    },
    interaction: {
      openQuestions,
      awaitingHumanAnswer: Boolean(interaction.awaitingHumanAnswer || openQuestions.length > 0),
      awaitingMerge: Boolean(interaction.awaitingMerge),
      needsHumanInput: Boolean(interaction.awaitingHumanAnswer || interaction.awaitingMerge || openQuestions.length > 0),
    },
    workflow: {
      reviewCompleted: Boolean(workflow.reviewCompleted),
      reviewApproved: Boolean(workflow.reviewApproved),
      findingsResolved: Boolean(workflow.findingsResolved),
      branchPushed: Boolean(workflow.branchPushed),
      worktreeClean: Boolean(workflow.worktreeClean),
      prExists: Boolean(workflow.prExists),
      ciGreen: Boolean(workflow.ciGreen),
      hasMergeConflicts: Boolean(workflow.hasMergeConflicts),
      prMergeable: Boolean(workflow.prMergeable),
      endStateReached: Boolean(workflow.endStateReached),
      readyForMerge,
      incomplete: !workflow.endStateReached && !readyForMerge,
    },
    resume: {
      blockReason,
      resetAt: resume.resetAt,
      resetPassed,
      consecutivePokes,
      maxConsecutivePokes,
      pokeBudgetExhausted,
      canPokeNow,
      shouldWaitForReset,
      tempRateLimited,
    },
  };
}

function buildCard(state: DominantAgentState, facts: NormalizedHarnessFacts): CardView {
  switch (state) {
    case 'running':
      return {
        badge: 'Running',
        subline: facts.runtime.monitorActivity || facts.runtime.backgroundActivity ? 'Background work is still active' : 'Agent is actively executing',
        action: 'none',
      };
    case 'needs_reply':
      return {
        badge: 'Needs reply',
        subline: facts.interaction.openQuestions.length > 0
          ? `${facts.interaction.openQuestions.length} unanswered question${facts.interaction.openQuestions.length === 1 ? '' : 's'}`
          : 'Agent is waiting for human input',
        action: 'reply',
      };
    case 'needs_poke':
      return {
        badge: 'Needs poke',
        subline: facts.resume.tempRateLimited
          ? `Temporary rate limit, poke ${facts.resume.consecutivePokes}/${facts.resume.maxConsecutivePokes}`
          : `Workflow incomplete, poke ${facts.resume.consecutivePokes}/${facts.resume.maxConsecutivePokes}`,
        action: 'poke',
      };
    case 'waiting_reset':
      return {
        badge: 'Waiting reset',
        subline: `Usage resets at ${formatClock(facts.resume.resetAt)}`,
        action: 'none',
      };
    case 'ready_to_merge':
      return {
        badge: 'Ready to merge',
        subline: 'PR green, review approved, no conflicts',
        action: 'merge',
      };
    case 'broken':
      return {
        badge: 'Broken',
        subline: facts.runtime.failureDetail || facts.runtime.failureKind || 'Runtime recovery required',
        action: 'recover',
      };
    case 'deferred_to_human':
      return {
        badge: 'Deferred',
        subline: `Poke budget exhausted at ${facts.resume.consecutivePokes}/${facts.resume.maxConsecutivePokes}`,
        action: 'review',
      };
    case 'done':
      return {
        badge: 'Done',
        subline: 'End state reached',
        action: 'none',
      };
  }
}

export function evaluateAgentState(evidence: HarnessEvidence): HarnessEvaluation {
  const facts = normalizeHarnessFacts(evidence);
  const explanationPath: string[] = [];

  if (facts.runtime.isBroken) {
    explanationPath.push('runtime.isBroken');
    return {
      facts,
      dominantState: 'broken',
      reason: facts.runtime.failureKind || 'broken_runtime',
      explanationPath,
      card: buildCard('broken', facts),
    };
  }

  if (facts.runtime.isRunning) {
    explanationPath.push('runtime.isRunning');
    return {
      facts,
      dominantState: 'running',
      reason: facts.runtime.monitorActivity || facts.runtime.backgroundActivity ? 'background_activity_detected' : 'runtime_active',
      explanationPath,
      card: buildCard('running', facts),
    };
  }

  if (facts.workflow.endStateReached) {
    explanationPath.push('workflow.endStateReached');
    return {
      facts,
      dominantState: 'done',
      reason: 'end_state_reached',
      explanationPath,
      card: buildCard('done', facts),
    };
  }

  if (facts.interaction.awaitingHumanAnswer) {
    explanationPath.push('interaction.awaitingHumanAnswer');
    return {
      facts,
      dominantState: 'needs_reply',
      reason: 'waiting_for_human_answer',
      explanationPath,
      card: buildCard('needs_reply', facts),
    };
  }

  if (facts.workflow.readyForMerge || facts.interaction.awaitingMerge) {
    explanationPath.push(facts.workflow.readyForMerge ? 'workflow.readyForMerge' : 'interaction.awaitingMerge');
    return {
      facts,
      dominantState: 'ready_to_merge',
      reason: facts.workflow.readyForMerge ? 'ready_for_merge' : 'awaiting_merge',
      explanationPath,
      card: buildCard('ready_to_merge', facts),
    };
  }

  if (facts.resume.pokeBudgetExhausted) {
    explanationPath.push('resume.pokeBudgetExhausted');
    return {
      facts,
      dominantState: 'deferred_to_human',
      reason: 'poke_budget_exhausted',
      explanationPath,
      card: buildCard('deferred_to_human', facts),
    };
  }

  if (facts.workflow.incomplete && facts.resume.shouldWaitForReset) {
    explanationPath.push('workflow.incomplete', 'resume.shouldWaitForReset');
    return {
      facts,
      dominantState: 'waiting_reset',
      reason: 'usage_limit_waiting_for_reset',
      explanationPath,
      card: buildCard('waiting_reset', facts),
    };
  }

  if (facts.workflow.incomplete && facts.resume.canPokeNow) {
    explanationPath.push('workflow.incomplete', 'resume.canPokeNow');
    return {
      facts,
      dominantState: 'needs_poke',
      reason: facts.resume.tempRateLimited ? 'temporary_rate_limit_retry_now' : 'resume_needed',
      explanationPath,
      card: buildCard('needs_poke', facts),
    };
  }

  explanationPath.push('workflow.incomplete', 'default_deferred_to_human');
  return {
    facts,
    dominantState: 'deferred_to_human',
    reason: 'unclassified_incomplete_state',
    explanationPath,
    card: buildCard('deferred_to_human', facts),
  };
}
