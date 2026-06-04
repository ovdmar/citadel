-- Synthetic seed data for `make seed`. References @CHECKOUT@ as a placeholder
-- for the absolute path to the current checkout; scripts/dev/seed.ts replaces
-- it at apply time. INSERT OR IGNORE everywhere — re-running is a no-op.
--
-- Tables intentionally NOT touched: agent_sessions, background_sessions,
-- operations, scheduled_agents, scheduled_agent_runs. These reference live
-- tmux/session state and would race the worktree daemon's session manager.

BEGIN;

-- Namespace ------------------------------------------------------------------

INSERT OR IGNORE INTO namespaces (id, name, color, created_at, updated_at, archived_at)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  'Demo',
  '#7c3aed',
  '2026-05-01T10:00:00.000Z',
  '2026-05-01T10:00:00.000Z',
  NULL
);

-- Repo (points at the mock repo materialized by seeds/setup.sh) -------------

INSERT OR IGNORE INTO repos (
  id, name, root_path, default_branch, default_remote, worktree_parent,
  setup_hook_ids, teardown_hook_ids, provider_ids,
  created_at, updated_at, archived_at, deploy_hook_command
)
VALUES (
  '11111111-1111-4111-8111-111111111111',
  'MockRepo',
  '@CHECKOUT@/.citadel/mock-repo',
  'main',
  'origin',
  '@CHECKOUT@/.citadel/mock-worktrees',
  '[]',
  '[]',
  '[]',
  '2026-05-01T10:00:00.000Z',
  '2026-05-01T10:00:00.000Z',
  NULL,
  NULL
);

-- Workspaces ----------------------------------------------------------------
-- demo-feature: in-progress, has a PR snapshot (#42, open, green)
-- demo-backlog: brand-new, no PR

INSERT OR IGNORE INTO workspaces (
  id, repo_id, name, path, root_path, mode, branch, base_branch, source, section, pinned,
  lifecycle, dirty, created_at, updated_at, kind, lifecycle_phase, namespace_id,
  pr_url, pr_number, pr_state, pr_last_fetch_at, pr_last_checks_green_at,
  pr_last_head_sha, pr_last_head_sha_changed_at, pr_last_merge_state_status,
  issue_key, issue_title, issue_url
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'demo-feature',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-feature',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-feature',
  'freestyle',
  'feature/demo-feature',
  'main',
  'scratch',
  'in-progress',
  0,
  'active',
  0,
  '2026-05-15T09:00:00.000Z',
  '2026-05-27T18:00:00.000Z',
  'worktree',
  'implementation',
  '22222222-2222-4222-8222-222222222222',
  'https://github.com/mockowner/mockrepo/pull/42',
  42,
  'OPEN',
  '2026-05-27T18:00:00.000Z',
  '2026-05-27T17:50:00.000Z',
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  '2026-05-26T12:00:00.000Z',
  'CLEAN',
  'CITADEL-1',
  'Demo feature: version export',
  'https://example.atlassian.net/browse/CITADEL-1'
);

INSERT OR IGNORE INTO workspaces (
  id, repo_id, name, path, root_path, mode, branch, base_branch, source, section, pinned,
  lifecycle, dirty, created_at, updated_at, kind, lifecycle_phase, namespace_id
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'demo-backlog',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-backlog',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-backlog',
  'freestyle',
  'feature/demo-backlog',
  'main',
  'scratch',
  'backlog',
  0,
  'active',
  0,
  '2026-05-20T11:00:00.000Z',
  '2026-05-20T11:00:00.000Z',
  'worktree',
  'implementation',
  '22222222-2222-4222-8222-222222222222'
);

-- structured-delivery: root + two checkouts for agents-system QA. One
-- checkout is ready for human review; the other is blocked by failing checks
-- and an open plan deviation.

INSERT OR IGNORE INTO workspaces (
  id, repo_id, name, path, root_path, mode, branch, base_branch, source, section, pinned,
  lifecycle, dirty, created_at, updated_at, kind, lifecycle_phase, namespace_id,
  parent_issue_provider, parent_issue_key, parent_issue_url, parent_issue_title, parent_issue_status
)
VALUES (
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'structured-delivery',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery',
  'structured',
  'feature/structured-delivery',
  'main',
  'issue',
  'in-progress',
  1,
  'ready',
  0,
  '2026-05-24T09:00:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'root',
  'ready_for_human_review',
  '22222222-2222-4222-8222-222222222222',
  'jira',
  'CITADEL-42',
  'https://example.atlassian.net/browse/CITADEL-42',
  'Structured agents delivery',
  'In Review'
);

INSERT OR IGNORE INTO workspace_checkouts (
  id, workspace_id, repo_id, name, path, branch, base_branch,
  issue_provider, issue_key, issue_url, issue_title, issue_status, issue_fetched_at,
  intended_pr_provider, intended_pr_number, intended_pr_url, pr_head_sha, pr_base_ref,
  intended_pr_fetched_at, intended_pr_checks_green, intended_pr_merge_state_status, intended_pr_has_conflicts,
  stack_parent_checkout_id, inferred_purpose, gate_status, created_at, updated_at, archived_at
)
VALUES
(
  'co_seed_review_ready',
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'review-ready',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery/review-ready',
  'feature/structured-review',
  'main',
  'jira',
  'CITADEL-43',
  'https://example.atlassian.net/browse/CITADEL-43',
  'Review-ready implementation slice',
  'In Review',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'github',
  77,
  'https://github.com/mockowner/mockrepo/pull/77',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'main',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  1,
  'CLEAN',
  0,
  NULL,
  'implementation',
  'ready_for_human_review',
  '2026-05-24T10:00:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  NULL
),
(
  'co_seed_blocked_checks',
  '55555555-5555-4555-8555-555555555555',
  '11111111-1111-4111-8111-111111111111',
  'blocked-checks',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery/blocked-checks',
  'feature/structured-blocked',
  'main',
  'jira',
  'CITADEL-44',
  'https://example.atlassian.net/browse/CITADEL-44',
  'Blocked implementation slice',
  'In Progress',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'github',
  78,
  'https://github.com/mockowner/mockrepo/pull/78',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'main',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  0,
  'CLEAN',
  0,
  'co_seed_review_ready',
  'implementation',
  'checks_failing',
  '2026-05-24T10:15:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  NULL
);

INSERT OR IGNORE INTO workspace_plan_versions (
  id, workspace_id, version, status, path, hash, active, approval_mode, created_by_session_id, created_at, updated_at
)
VALUES (
  'plan_seed_approved',
  '55555555-5555-4555-8555-555555555555',
  1,
  'approved',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery/.citadel/plans/approved-plan.md',
  'seeded-plan-hash-structured-delivery-v1',
  1,
  'manual',
  NULL,
  '2026-05-24T09:30:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT OR IGNORE INTO workspace_plan_reviews (id, plan_version_id, reviewer, result, artifact_path, created_at)
VALUES (
  'plan_review_seed_approved',
  'plan_seed_approved',
  'review-tech-plan',
  'approve',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery/.citadel/plans/review-tech-plan.md',
  '2026-05-24T09:45:00.000Z'
);

INSERT OR IGNORE INTO workspace_plan_decisions (id, plan_version_id, decision, reason, actor, created_at)
VALUES (
  'plan_decision_seed_approved',
  'plan_seed_approved',
  'approve',
  'Seeded approved plan for structured QA',
  'human',
  '2026-05-24T09:50:00.000Z'
);

INSERT OR IGNORE INTO workspace_managers (
  id, workspace_id, pause_state, heartbeat_interval_seconds, last_heartbeat_at, created_at, updated_at
)
VALUES (
  'mgr_seed_structured',
  '55555555-5555-4555-8555-555555555555',
  'running',
  300,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  '2026-05-24T09:05:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT OR IGNORE INTO manager_events (
  id, workspace_id, manager_id, type, scope_key, action_key, idempotency_key, status, message, created_at
)
VALUES
(
  'mgr_evt_seed_ready',
  '55555555-5555-4555-8555-555555555555',
  'mgr_seed_structured',
  'checkout.ready_for_human_review',
  'checkout:co_seed_review_ready',
  'manager.notify_ready_for_human_review',
  'seed-ready-review-ready',
  'succeeded',
  'Seeded ready checkout notification',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
),
(
  'mgr_evt_seed_blocked',
  '55555555-5555-4555-8555-555555555555',
  'mgr_seed_structured',
  'checkout.blocked',
  'checkout:co_seed_blocked_checks',
  'implementation.fix_ci',
  'seed-blocked-checks',
  'skipped',
  'Seeded checkout has failing checks and an open deviation',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT OR IGNORE INTO plan_deviation_reports (
  id, workspace_id, checkout_id, plan_version_id, severity, description, status,
  reported_by_session_id, created_at, resolved_at
)
VALUES (
  'dev_seed_blocked_checks',
  '55555555-5555-4555-8555-555555555555',
  'co_seed_blocked_checks',
  'plan_seed_approved',
  'blocking',
  'Seeded deviation: CI failure changed the handoff assumptions for this delivery unit.',
  'open',
  NULL,
  '2026-05-24T12:30:00.000Z',
  NULL
);

INSERT OR IGNORE INTO checkout_review_artifacts (
  id, workspace_id, checkout_id, plan_version_id, pr_provider, pr_number, pr_url, head_sha,
  result, findings_status, blocking_findings, artifact_path, created_at
)
VALUES (
  'review_seed_ready',
  '55555555-5555-4555-8555-555555555555',
  'co_seed_review_ready',
  'plan_seed_approved',
  'github',
  77,
  'https://github.com/mockowner/mockrepo/pull/77',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'approve',
  'none',
  '[]',
  '@CHECKOUT@/.citadel/mock-worktrees/structured-delivery/.citadel/reviews/review-ready.md',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

INSERT OR IGNORE INTO workspace_sessions (
  id, workspace_id, kind, runtime_id, display_name, status, status_reason, status_reason_at,
  target_type, checkout_id, role, action_id, managed, parent_session_id, plan_version_id, closed_at, launch_warnings,
  last_status_at, last_output_at, ended_at, exit_code, transport,
  tmux_session_name, tmux_session_id, tmux_socket_name, tab_id, runtime_session_id,
  rate_limit_resume_attempts, next_resume_at, last_resume_from_rate_limit_at, created_at, updated_at
)
VALUES
(
  'sess_seed_pm',
  '55555555-5555-4555-8555-555555555555',
  'agent',
  'claude-code',
  'PM discovery',
  'stopped',
  'seed_closed_history',
  '2026-05-24T09:20:00.000Z',
  'workspace_home',
  NULL,
  'pm',
  NULL,
  1,
  NULL,
  NULL,
  '2026-05-24T09:20:00.000Z',
  '["seeded closed role session; launch a new one to create a live tmux pane"]',
  '2026-05-24T09:20:00.000Z',
  '2026-05-24T09:18:00.000Z',
  '2026-05-24T09:20:00.000Z',
  0,
  'disconnected',
  NULL,
  NULL,
  NULL,
  'tab_seed_home_pm',
  'runtime_seed_pm',
  0,
  NULL,
  NULL,
  '2026-05-24T09:10:00.000Z',
  '2026-05-24T09:20:00.000Z'
),
(
  'sess_seed_architect',
  '55555555-5555-4555-8555-555555555555',
  'agent',
  'claude-code',
  'Architect plan',
  'stopped',
  'seed_closed_history',
  '2026-05-24T09:55:00.000Z',
  'workspace_home',
  NULL,
  'architect',
  NULL,
  1,
  'sess_seed_pm',
  'plan_seed_approved',
  '2026-05-24T09:55:00.000Z',
  '[]',
  '2026-05-24T09:55:00.000Z',
  '2026-05-24T09:53:00.000Z',
  '2026-05-24T09:55:00.000Z',
  0,
  'disconnected',
  NULL,
  NULL,
  NULL,
  'tab_seed_home_architect',
  'runtime_seed_architect',
  0,
  NULL,
  NULL,
  '2026-05-24T09:25:00.000Z',
  '2026-05-24T09:55:00.000Z'
),
(
  'sess_seed_implementation',
  '55555555-5555-4555-8555-555555555555',
  'agent',
  'claude-code',
  'Implementation review-ready',
  'stopped',
  'seed_closed_history',
  '2026-05-24T11:20:00.000Z',
  'worktree_checkout',
  'co_seed_review_ready',
  'implementation',
  NULL,
  1,
  'sess_seed_architect',
  'plan_seed_approved',
  '2026-05-24T11:20:00.000Z',
  '[]',
  '2026-05-24T11:20:00.000Z',
  '2026-05-24T11:18:00.000Z',
  '2026-05-24T11:20:00.000Z',
  0,
  'disconnected',
  NULL,
  NULL,
  NULL,
  'tab_seed_checkout_impl',
  'runtime_seed_implementation',
  0,
  NULL,
  NULL,
  '2026-05-24T10:05:00.000Z',
  '2026-05-24T11:20:00.000Z'
),
(
  'sess_seed_prototype',
  '55555555-5555-4555-8555-555555555555',
  'agent',
  'claude-code',
  'Prototype blocked slice',
  'stopped',
  'seed_closed_history',
  '2026-05-24T10:45:00.000Z',
  'worktree_checkout',
  'co_seed_blocked_checks',
  'prototype',
  NULL,
  1,
  'sess_seed_pm',
  NULL,
  '2026-05-24T10:45:00.000Z',
  '[]',
  '2026-05-24T10:45:00.000Z',
  '2026-05-24T10:42:00.000Z',
  '2026-05-24T10:45:00.000Z',
  0,
  'disconnected',
  NULL,
  NULL,
  NULL,
  'tab_seed_checkout_proto',
  'runtime_seed_prototype',
  0,
  NULL,
  NULL,
  '2026-05-24T10:20:00.000Z',
  '2026-05-24T10:45:00.000Z'
),
(
  'sess_seed_manager',
  '55555555-5555-4555-8555-555555555555',
  'agent',
  'claude-code',
  'Manager digest',
  'stopped',
  'seed_closed_history',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'workspace_home',
  NULL,
  'manager',
  'manager.heartbeat_digest',
  1,
  NULL,
  'plan_seed_approved',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  '[]',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  0,
  'disconnected',
  NULL,
  NULL,
  NULL,
  'tab_seed_home_manager',
  'runtime_seed_manager',
  0,
  NULL,
  NULL,
  '2026-05-24T12:00:00.000Z',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);

-- Activity feed -------------------------------------------------------------

INSERT OR IGNORE INTO activity_events (id, type, source, repo_id, workspace_id, operation_id, message, created_at) VALUES
('a0000001-0001-4001-8001-000000000001', 'namespace.created', 'user',           NULL,                                   NULL,                                   NULL, 'Created namespace Demo',                       '2026-05-01T10:00:00.000Z'),
('a0000002-0002-4002-8002-000000000002', 'workspace.created', 'user',           '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Created workspace demo-feature',               '2026-05-15T09:00:00.000Z'),
('a0000003-0003-4003-8003-000000000003', 'agent.started',     'user',           '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Started agent claude on demo-feature',         '2026-05-15T09:05:00.000Z'),
('a0000004-0004-4004-8004-000000000004', 'agent.stopped',     'user',           '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Stopped agent claude on demo-feature',         '2026-05-15T10:30:00.000Z'),
('a0000005-0005-4005-8005-000000000005', 'deploy.redeploy',   'user',           NULL,                                   NULL,                                   NULL, 'Triggered redeploy from cockpit',              '2026-05-20T08:00:00.000Z'),
('a0000006-0006-4006-8006-000000000006', 'workspace.created', 'user',           '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', NULL, 'Created workspace demo-backlog',               '2026-05-20T11:00:00.000Z'),
('a0000007-0007-4007-8007-000000000007', 'agent.message',     'system',         '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Daemon resumed agent after rate-limit window', '2026-05-21T07:00:00.000Z'),
('a0000008-0008-4008-8008-000000000008', 'agent.started',     'automatic-rule', '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Auto-restart fired for demo-feature',          '2026-05-22T03:00:00.000Z'),
('a0000009-0009-4009-8009-000000000009', 'namespace.updated', 'user',           NULL,                                   NULL,                                   NULL, 'Renamed namespace to Demo',                    '2026-05-23T15:00:00.000Z'),
('a000000a-000a-400a-800a-00000000000a', 'agent.message',     'user',           '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Sent message to demo-feature agent',           '2026-05-27T17:00:00.000Z'),
('a000000b-000b-400b-800b-00000000000b', 'workspace.created', 'user',           '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Created structured workspace structured-delivery', '2026-05-24T09:00:00.000Z'),
('a000000c-000c-400c-800c-00000000000c', 'workspace.manager.started', 'mcp',    '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Started workspace manager',                    '2026-05-24T09:05:00.000Z'),
('a000000d-000d-400d-800d-00000000000d', 'workspace.plan.registered', 'agent',  '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Registered workspace plan v1',                 '2026-05-24T09:50:00.000Z'),
('a000000e-000e-400e-800e-00000000000e', 'workspace.checkout.created', 'mcp',   '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Created checkout review-ready',                '2026-05-24T10:00:00.000Z'),
('a000000f-000f-400f-800f-00000000000f', 'workspace.checkout.created', 'mcp',   '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Created checkout blocked-checks',              '2026-05-24T10:15:00.000Z'),
('a0000010-0010-4010-8010-000000000010', 'workspace.plan.deviation_reported', 'agent', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'Plan deviation reported for blocked-checks',   '2026-05-24T12:30:00.000Z'),
('a0000011-0011-4011-8011-000000000011', 'workspace.checkout.ready_for_review', 'mcp', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555555', NULL, 'review-ready is ready for human review',       strftime('%Y-%m-%dT%H:%M:%fZ','now'));

COMMIT;
