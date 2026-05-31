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
  id, repo_id, name, path, branch, base_branch, source, section, pinned,
  lifecycle, dirty, created_at, updated_at, kind, namespace_id,
  pr_url, pr_number, pr_state, pr_last_fetch_at, pr_last_checks_green_at,
  pr_last_head_sha, pr_last_head_sha_changed_at, pr_last_merge_state_status,
  issue_key, issue_title, issue_url
)
VALUES (
  '33333333-3333-4333-8333-333333333333',
  '11111111-1111-4111-8111-111111111111',
  'demo-feature',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-feature',
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
  id, repo_id, name, path, branch, base_branch, source, section, pinned,
  lifecycle, dirty, created_at, updated_at, kind, namespace_id
)
VALUES (
  '44444444-4444-4444-8444-444444444444',
  '11111111-1111-4111-8111-111111111111',
  'demo-backlog',
  '@CHECKOUT@/.citadel/mock-worktrees/demo-backlog',
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
  '22222222-2222-4222-8222-222222222222'
);

-- Activity feed (~10 events) ------------------------------------------------

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
('a000000a-000a-400a-800a-00000000000a', 'agent.message',     'user',           '11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333', NULL, 'Sent message to demo-feature agent',           '2026-05-27T17:00:00.000Z');

COMMIT;
