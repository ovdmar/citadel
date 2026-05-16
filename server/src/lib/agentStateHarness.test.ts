import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateAgentState, normalizeHarnessFacts, type HarnessEvidence, type DominantAgentState } from './agentStateHarness.js';

type Scenario = {
  name: string;
  evidence: HarnessEvidence;
  expectedState: DominantAgentState;
  expectedReason: string;
  expectedBadge: string;
  expectedAction: string;
  expectedPath: string[];
  assertFacts?: (facts: ReturnType<typeof normalizeHarnessFacts>) => void;
  assertSubline?: (subline: string) => void;
};

const baseNow = '2026-04-29T09:00:00Z';

const scenarios: Scenario[] = [
  {
    name: 'running when process is alive',
    evidence: {
      now: baseNow,
      runtime: { processAlive: true, tmuxSessionExists: true },
      workflow: { endStateReached: false },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'running',
    expectedReason: 'runtime_active',
    expectedBadge: 'Running',
    expectedAction: 'none',
    expectedPath: ['runtime.isRunning'],
    assertFacts: (facts) => assert.equal(facts.runtime.isRunning, true),
  },
  {
    name: 'background work beats stopped main turn markers',
    evidence: {
      now: baseNow,
      runtime: { backgroundActivity: true, tmuxSessionExists: true },
      interaction: { openQuestions: ['Old question that should not win while work is active'] },
      workflow: { endStateReached: false },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'running',
    expectedReason: 'background_activity_detected',
    expectedBadge: 'Running',
    expectedAction: 'none',
    expectedPath: ['runtime.isRunning'],
  },
  {
    name: 'explicit question becomes needs reply',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      interaction: { openQuestions: ['Which approach should I take?'] },
      workflow: { endStateReached: false },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'needs_reply',
    expectedReason: 'waiting_for_human_answer',
    expectedBadge: 'Needs reply',
    expectedAction: 'reply',
    expectedPath: ['interaction.awaitingHumanAnswer'],
    assertFacts: (facts) => assert.equal(facts.interaction.openQuestions.length, 1),
  },
  {
    name: 'multiple questions stay as needs reply',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      interaction: { openQuestions: ['Question 1', 'Question 2'] },
      workflow: { endStateReached: false },
      resume: { consecutivePokes: 1 },
    },
    expectedState: 'needs_reply',
    expectedReason: 'waiting_for_human_answer',
    expectedBadge: 'Needs reply',
    expectedAction: 'reply',
    expectedPath: ['interaction.awaitingHumanAnswer'],
    assertSubline: (subline) => assert.match(subline, /2 unanswered questions/),
  },
  {
    name: 'broken runtime wins over question state',
    evidence: {
      now: baseNow,
      runtime: { failureKind: 'tmux_missing', failureDetail: 'tmux disappeared', tmuxSessionExists: false, sessionResumable: false },
      interaction: { openQuestions: ['Still need an answer'] },
      workflow: { endStateReached: false },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'broken',
    expectedReason: 'tmux_missing',
    expectedBadge: 'Broken',
    expectedAction: 'recover',
    expectedPath: ['runtime.isBroken'],
  },
  {
    name: 'ready to merge when all workflow gates are green',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: {
        reviewCompleted: true,
        reviewApproved: true,
        findingsResolved: true,
        branchPushed: true,
        worktreeClean: true,
        prExists: true,
        ciGreen: true,
        hasMergeConflicts: false,
        prMergeable: true,
      },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'ready_to_merge',
    expectedReason: 'ready_for_merge',
    expectedBadge: 'Ready to merge',
    expectedAction: 'merge',
    expectedPath: ['workflow.readyForMerge'],
    assertFacts: (facts) => assert.equal(facts.workflow.readyForMerge, true),
  },
  {
    name: 'merge-ready beats exhausted poke budget',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true },
      workflow: {
        reviewCompleted: true,
        reviewApproved: true,
        findingsResolved: true,
        branchPushed: true,
        worktreeClean: true,
        prExists: true,
        ciGreen: true,
        prMergeable: true,
      },
      resume: { consecutivePokes: 3, maxConsecutivePokes: 3 },
    },
    expectedState: 'ready_to_merge',
    expectedReason: 'ready_for_merge',
    expectedBadge: 'Ready to merge',
    expectedAction: 'merge',
    expectedPath: ['workflow.readyForMerge'],
  },
  {
    name: 'needs poke when workflow is incomplete and resumable now',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { branchPushed: true, prExists: true, ciGreen: false },
      resume: { blockReason: 'none', consecutivePokes: 1, maxConsecutivePokes: 3 },
    },
    expectedState: 'needs_poke',
    expectedReason: 'resume_needed',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
  },
  {
    name: 'temporary provider rate limit still allows immediate poke',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { prExists: true, ciGreen: false },
      resume: { blockReason: 'temp_rate_limit', consecutivePokes: 2, maxConsecutivePokes: 3 },
    },
    expectedState: 'needs_poke',
    expectedReason: 'temporary_rate_limit_retry_now',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
    assertFacts: (facts) => {
      assert.equal(facts.resume.tempRateLimited, true);
      assert.equal(facts.resume.canPokeNow, true);
    },
  },
  {
    name: 'usage limit in future becomes waiting reset',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { prExists: true, ciGreen: false },
      resume: {
        blockReason: 'usage_limit',
        resetAt: '2026-04-29T11:20:00Z',
        consecutivePokes: 1,
        maxConsecutivePokes: 3,
      },
    },
    expectedState: 'waiting_reset',
    expectedReason: 'usage_limit_waiting_for_reset',
    expectedBadge: 'Waiting reset',
    expectedAction: 'none',
    expectedPath: ['workflow.incomplete', 'resume.shouldWaitForReset'],
    assertFacts: (facts) => {
      assert.equal(facts.resume.shouldWaitForReset, true);
      assert.equal(facts.resume.canPokeNow, false);
    },
    assertSubline: (subline) => assert.match(subline, /Usage resets at/),
  },
  {
    name: 'usage limit after reset becomes needs poke',
    evidence: {
      now: '2026-04-29T12:00:00Z',
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { prExists: true, ciGreen: false },
      resume: {
        blockReason: 'usage_limit',
        resetAt: '2026-04-29T11:20:00Z',
        consecutivePokes: 1,
        maxConsecutivePokes: 3,
      },
    },
    expectedState: 'needs_poke',
    expectedReason: 'resume_needed',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
    assertFacts: (facts) => assert.equal(facts.resume.resetPassed, true),
  },
  {
    name: 'poke budget exhausted defers to human',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { prExists: true, ciGreen: false },
      resume: { consecutivePokes: 3, maxConsecutivePokes: 3 },
    },
    expectedState: 'deferred_to_human',
    expectedReason: 'poke_budget_exhausted',
    expectedBadge: 'Deferred',
    expectedAction: 'review',
    expectedPath: ['resume.pokeBudgetExhausted'],
    assertSubline: (subline) => assert.match(subline, /3\/3/),
  },
  {
    name: 'explicit poke-budget block reason also defers',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: { prExists: true, ciGreen: false },
      resume: { blockReason: 'poke_budget_exhausted', consecutivePokes: 2, maxConsecutivePokes: 3 },
    },
    expectedState: 'deferred_to_human',
    expectedReason: 'poke_budget_exhausted',
    expectedBadge: 'Deferred',
    expectedAction: 'review',
    expectedPath: ['resume.pokeBudgetExhausted'],
  },
  {
    name: 'done when end state is reached',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true },
      workflow: { endStateReached: true },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'done',
    expectedReason: 'end_state_reached',
    expectedBadge: 'Done',
    expectedAction: 'none',
    expectedPath: ['workflow.endStateReached'],
  },
  {
    name: 'done beats merge readiness flags if job is already terminal',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true },
      workflow: {
        endStateReached: true,
        reviewCompleted: true,
        reviewApproved: true,
        findingsResolved: true,
        branchPushed: true,
        worktreeClean: true,
        prExists: true,
        ciGreen: true,
        prMergeable: true,
      },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'done',
    expectedReason: 'end_state_reached',
    expectedBadge: 'Done',
    expectedAction: 'none',
    expectedPath: ['workflow.endStateReached'],
  },
  {
    name: 'not merge-ready if conflicts exist even with green CI',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: {
        reviewCompleted: true,
        reviewApproved: true,
        findingsResolved: true,
        branchPushed: true,
        worktreeClean: true,
        prExists: true,
        ciGreen: true,
        hasMergeConflicts: true,
        prMergeable: false,
      },
      resume: { consecutivePokes: 1 },
    },
    expectedState: 'needs_poke',
    expectedReason: 'resume_needed',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
    assertFacts: (facts) => assert.equal(facts.workflow.readyForMerge, false),
  },
  {
    name: 'not merge-ready if findings remain unresolved',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, sessionResumable: true },
      workflow: {
        reviewCompleted: true,
        reviewApproved: true,
        findingsResolved: false,
        branchPushed: true,
        worktreeClean: true,
        prExists: true,
        ciGreen: true,
        prMergeable: true,
      },
      resume: { consecutivePokes: 1 },
    },
    expectedState: 'needs_poke',
    expectedReason: 'resume_needed',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
  },
  {
    name: 'awaiting merge signal maps to ready to merge card',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true },
      interaction: { awaitingMerge: true },
      workflow: { prExists: true, ciGreen: true },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'ready_to_merge',
    expectedReason: 'awaiting_merge',
    expectedBadge: 'Ready to merge',
    expectedAction: 'merge',
    expectedPath: ['interaction.awaitingMerge'],
  },
  {
    name: 'broken session dead without recovery path is broken',
    evidence: {
      now: baseNow,
      runtime: { failureKind: 'session_dead', failureDetail: 'session handle invalid', sessionResumable: false, tmuxSessionExists: false },
      workflow: { prExists: true },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'broken',
    expectedReason: 'session_dead',
    expectedBadge: 'Broken',
    expectedAction: 'recover',
    expectedPath: ['runtime.isBroken'],
  },
  {
    name: 'recoverable stopped job without workflow completion still defaults to poke',
    evidence: {
      now: baseNow,
      runtime: { tmuxSessionExists: true, recoveryShellAvailable: true },
      workflow: { prExists: false, ciGreen: false },
      resume: { consecutivePokes: 0 },
    },
    expectedState: 'needs_poke',
    expectedReason: 'resume_needed',
    expectedBadge: 'Needs poke',
    expectedAction: 'poke',
    expectedPath: ['workflow.incomplete', 'resume.canPokeNow'],
  },
];

for (const scenario of scenarios) {
  test(scenario.name, () => {
    const evaluation = evaluateAgentState(scenario.evidence);

    assert.equal(evaluation.dominantState, scenario.expectedState);
    assert.equal(evaluation.reason, scenario.expectedReason);
    assert.equal(evaluation.card.badge, scenario.expectedBadge);
    assert.equal(evaluation.card.action, scenario.expectedAction);
    assert.deepEqual(evaluation.explanationPath, scenario.expectedPath);
    scenario.assertFacts?.(evaluation.facts);
    scenario.assertSubline?.(evaluation.card.subline);
  });
}

test('normalization exposes the core orthogonal facts', () => {
  const facts = normalizeHarnessFacts({
    now: baseNow,
    runtime: {
      tmuxSessionExists: true,
      processAlive: false,
      backgroundActivity: true,
      sessionResumable: true,
    },
    interaction: {
      openQuestions: ['First', 'Second'],
    },
    workflow: {
      reviewCompleted: true,
      reviewApproved: true,
      findingsResolved: true,
      branchPushed: true,
      worktreeClean: true,
      prExists: true,
      ciGreen: true,
      prMergeable: true,
    },
    resume: {
      blockReason: 'temp_rate_limit',
      consecutivePokes: 2,
      maxConsecutivePokes: 3,
    },
  });

  assert.equal(facts.runtime.isRunning, true);
  assert.equal(facts.runtime.isRecoverable, true);
  assert.equal(facts.interaction.needsHumanInput, true);
  assert.equal(facts.workflow.readyForMerge, true);
  assert.equal(facts.resume.tempRateLimited, true);
  assert.equal(facts.resume.canPokeNow, true);
});
