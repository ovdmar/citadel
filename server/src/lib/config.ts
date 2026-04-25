import type { WorkflowConfig } from '../types.js';

export const APP_NAME = 'Citadel';
export const API_PORT = Number(process.env.CITADEL_PORT || 4010);
export const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT || '/Users/jonsnow/.openclaw';
export const OPENCLAW_CONFIG_PATH = `${OPENCLAW_ROOT}/openclaw.json`;
export const OPERATOR_DATA_PATH = `${OPENCLAW_ROOT}/workspace/citadel-data/operator-flags.json`;
export const TTYD_BIN = process.env.TTYD_BIN || '/opt/homebrew/bin/ttyd';
export const TERMINAL_PORT_BASE = Number(process.env.CITADEL_TTYD_PORT_BASE || 7681);
export const TERMINAL_PORT_MAX = Number(process.env.CITADEL_TTYD_PORT_MAX || 7720);
export const JOB_STALE_MINUTES = Number(process.env.CITADEL_STALE_MINUTES || 20);

export const WORKFLOWS: WorkflowConfig[] = [
  {
    key: 'implementation',
    label: 'Implementation',
    channelId: 'C0APDHM5TRR',
    stateDir: `${OPENCLAW_ROOT}/workspace-implementation/automation/implementation-jira/state/active`,
    reconcileCommand: ['python3', `${OPENCLAW_ROOT}/workspace-implementation/automation/implementation-jira/scripts/run-reconciler-pass.py`],
    classifyMode: 'implementation'
  },
  {
    key: 'tech-plan',
    label: 'Tech Plan',
    channelId: 'C0AP1ADLB71',
    stateDir: `${OPENCLAW_ROOT}/workspace-tech-plan/automation/tech-plan-jira/state/active`,
    reconcileCommand: ['python3', `${OPENCLAW_ROOT}/workspace-tech-plan/automation/tech-plan-jira/scripts/run-reconciler-pass.py`],
    classifyMode: 'tech-plan'
  },
  {
    key: 'concept-lab',
    label: 'Concept Lab',
    channelId: 'C0AS0AGTX4N',
    stateDir: `${OPENCLAW_ROOT}/workspace-concept-lab/automation/concept-lab/state/active`,
    reconcileCommand: ['python3', `${OPENCLAW_ROOT}/workspace-concept-lab/automation/concept-lab/scripts/run-reconciler-pass.py`],
    classifyMode: 'concept-lab'
  }
];
