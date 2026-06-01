import type {
  ActivityEvent,
  BackgroundAgentSession,
  HookOutput,
  Operation,
  OperationLogEntry,
  Repo,
  ScheduledAgent,
  ScheduledAgentRun,
  Workspace,
  WorkspaceSession,
} from "@citadel/contracts";

export function asString(row: Record<string, unknown>, key: string) {
  return String(row[key] ?? "");
}

export function jsonArray(row: Record<string, unknown>, key: string) {
  const raw = asString(row, key);
  return raw ? (JSON.parse(raw) as string[]) : [];
}

export function jsonObject<T>(row: Record<string, unknown>, key: string) {
  const raw = asString(row, key);
  return raw ? (JSON.parse(raw) as T) : null;
}

export function repoFromRow(row: Record<string, unknown>): Repo {
  return {
    id: asString(row, "id"),
    name: asString(row, "name"),
    rootPath: asString(row, "root_path"),
    defaultBranch: asString(row, "default_branch"),
    defaultRemote: asString(row, "default_remote"),
    worktreeParent: asString(row, "worktree_parent"),
    setupHookIds: jsonArray(row, "setup_hook_ids"),
    teardownHookIds: jsonArray(row, "teardown_hook_ids"),
    providerIds: jsonArray(row, "provider_ids"),
    deployHookCommand: row.deploy_hook_command ? asString(row, "deploy_hook_command") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

export function workspaceFromRow(row: Record<string, unknown>): Workspace {
  const parentIssue =
    row.parent_issue_provider && row.parent_issue_key
      ? {
          provider: asString(row, "parent_issue_provider"),
          key: asString(row, "parent_issue_key"),
          url: row.parent_issue_url ? asString(row, "parent_issue_url") : null,
          title: row.parent_issue_title ? asString(row, "parent_issue_title") : null,
          status: row.parent_issue_status ? asString(row, "parent_issue_status") : null,
          fetchedAt: null,
        }
      : undefined;
  return {
    id: asString(row, "id"),
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    name: asString(row, "name"),
    path: asString(row, "path"),
    rootPath: row.root_path ? asString(row, "root_path") : undefined,
    mode: row.mode ? (asString(row, "mode") as Workspace["mode"]) : undefined,
    branch: asString(row, "branch"),
    baseBranch: asString(row, "base_branch"),
    source: asString(row, "source") as Workspace["source"],
    kind: ((row.kind as string) ?? "worktree") as Workspace["kind"],
    lifecyclePhase: row.lifecycle_phase ? (asString(row, "lifecycle_phase") as Workspace["lifecyclePhase"]) : undefined,
    parentIssue,
    prUrl: row.pr_url ? asString(row, "pr_url") : null,
    issueKey: row.issue_key ? asString(row, "issue_key") : null,
    issueTitle: row.issue_title ? asString(row, "issue_title") : null,
    issueUrl: row.issue_url ? asString(row, "issue_url") : null,
    slackThreadUrl: row.slack_thread_url ? asString(row, "slack_thread_url") : null,
    section: asString(row, "section"),
    pinned: Number(row.pinned) === 1,
    lifecycle: asString(row, "lifecycle") as Workspace["lifecycle"],
    dirty: Number(row.dirty) === 1,
    namespaceId: row.namespace_id ? asString(row, "namespace_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

export function sessionFromRow(row: Record<string, unknown>): WorkspaceSession {
  const kind = asString(row, "kind") === "terminal" ? "terminal" : "agent";
  const base = {
    id: asString(row, "id"),
    kind,
    workspaceId: asString(row, "workspace_id"),
    targetType: row.target_type ? (asString(row, "target_type") as WorkspaceSession["targetType"]) : undefined,
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    displayName: asString(row, "display_name"),
    status: asString(row, "status") as WorkspaceSession["status"],
    statusReason: row.status_reason ? asString(row, "status_reason") : null,
    statusReasonAt: row.status_reason_at ? asString(row, "status_reason_at") : null,
    // `||` (not `??`) is deliberate: asString() returns "" for null DB columns,
    // and we want the updated_at fallback to fire on the empty-string case.
    lastStatusAt: asString(row, "last_status_at") || asString(row, "updated_at"),
    lastOutputAt: row.last_output_at ? asString(row, "last_output_at") : null,
    endedAt: row.ended_at ? asString(row, "ended_at") : null,
    exitCode: row.exit_code === null || row.exit_code === undefined ? null : Number(row.exit_code),
    transport: asString(row, "transport") as WorkspaceSession["transport"],
    tmuxSessionName: row.tmux_session_name ? asString(row, "tmux_session_name") : null,
    tmuxSessionId: row.tmux_session_id ? asString(row, "tmux_session_id") : null,
    tmuxSocketName: row.tmux_socket_name ? asString(row, "tmux_socket_name") : null,
    // Fall back to the row id when tab_id is unset (older rows from before
    // migration 11, or in-memory fixtures that skip the migration). Treats
    // every legacy row as its own tab — matches pre-migration ordering.
    tabId: row.tab_id ? asString(row, "tab_id") : asString(row, "id"),
    runtimeSessionId: row.runtime_session_id ? asString(row, "runtime_session_id") : null,
    role: row.role ? (asString(row, "role") as WorkspaceSession["role"]) : null,
    actionId: row.action_id ? asString(row, "action_id") : null,
    managed: Number(row.managed ?? 0) === 1,
    parentSessionId: row.parent_session_id ? asString(row, "parent_session_id") : null,
    planVersionId: row.plan_version_id ? asString(row, "plan_version_id") : null,
    closedAt: row.closed_at ? asString(row, "closed_at") : null,
    launchWarnings: jsonArray(row, "launch_warnings"),
    rateLimitResumeAttempts:
      row.rate_limit_resume_attempts === null || row.rate_limit_resume_attempts === undefined
        ? 0
        : Number(row.rate_limit_resume_attempts),
    nextResumeAt: row.next_resume_at ? asString(row, "next_resume_at") : null,
    lastResumeFromRateLimitAt: row.last_resume_from_rate_limit_at
      ? asString(row, "last_resume_from_rate_limit_at")
      : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
  return kind === "terminal"
    ? { ...base, kind, runtimeId: null }
    : { ...base, kind, runtimeId: asString(row, "runtime_id") };
}

export function operationFromRow(row: Record<string, unknown>): Operation {
  const logs = jsonObject<OperationLogEntry[]>(row, "logs") ?? [];
  const retryInput = jsonObject<Record<string, unknown>>(row, "retry_input");
  return {
    id: asString(row, "id"),
    type: asString(row, "type"),
    status: asString(row, "status") as Operation["status"],
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    workspaceId: row.workspace_id ? asString(row, "workspace_id") : null,
    progress: Number(row.progress),
    message: row.message ? asString(row, "message") : null,
    error: row.error ? asString(row, "error") : null,
    logs,
    retriable: Number(row.retriable ?? 0) === 1,
    retryInput,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function scheduledAgentFromRow(row: Record<string, unknown>): ScheduledAgent {
  const scheduleType = (
    row.schedule_type ? asString(row, "schedule_type") : "recurring"
  ) as ScheduledAgent["scheduleType"];
  // cron is NOT NULL in the table; one-shot rows store a placeholder there and
  // we surface it as null on the typed object so callers don't act on it.
  const cronRaw = row.cron ? asString(row, "cron") : null;
  return {
    id: asString(row, "id"),
    name: asString(row, "name"),
    description: row.description ? asString(row, "description") : null,
    scheduleType,
    cron: scheduleType === "once" ? null : cronRaw,
    runAt: row.run_at ? asString(row, "run_at") : null,
    repoId: asString(row, "repo_id"),
    runtimeId: asString(row, "runtime_id"),
    prompt: row.prompt ? asString(row, "prompt") : null,
    workspaceStrategy: asString(row, "workspace_strategy") as ScheduledAgent["workspaceStrategy"],
    workspaceName: asString(row, "workspace_name"),
    baseBranch: row.base_branch ? asString(row, "base_branch") : null,
    runMode: (row.run_mode ? asString(row, "run_mode") : "workspace") as ScheduledAgent["runMode"],
    backgroundCwd: row.background_cwd ? asString(row, "background_cwd") : null,
    overlapPolicy: (row.overlap_policy ? asString(row, "overlap_policy") : "skip") as ScheduledAgent["overlapPolicy"],
    enabled: Number(row.enabled) === 1,
    lastRunAt: row.last_run_at ? asString(row, "last_run_at") : null,
    lastRunStatus: asString(row, "last_run_status") as ScheduledAgent["lastRunStatus"],
    lastRunMessage: row.last_run_message ? asString(row, "last_run_message") : null,
    lastWorkspaceId: row.last_workspace_id ? asString(row, "last_workspace_id") : null,
    lastSessionId: row.last_session_id ? asString(row, "last_session_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function scheduledAgentRunFromRow(row: Record<string, unknown>): ScheduledAgentRun {
  return {
    id: asString(row, "id"),
    scheduledAgentId: asString(row, "scheduled_agent_id"),
    status: asString(row, "status") as ScheduledAgentRun["status"],
    enqueuedAt: asString(row, "enqueued_at"),
    startedAt: row.started_at ? asString(row, "started_at") : null,
    endedAt: row.ended_at ? asString(row, "ended_at") : null,
    message: row.message ? asString(row, "message") : null,
    workspaceId: row.workspace_id ? asString(row, "workspace_id") : null,
    sessionId: row.session_id ? asString(row, "session_id") : null,
    backgroundSessionId: row.background_session_id ? asString(row, "background_session_id") : null,
    logFilePath: row.log_file_path ? asString(row, "log_file_path") : null,
  };
}

export function backgroundSessionFromRow(row: Record<string, unknown>): BackgroundAgentSession {
  return {
    id: asString(row, "id"),
    scheduledAgentId: row.scheduled_agent_id ? asString(row, "scheduled_agent_id") : null,
    cwd: asString(row, "cwd"),
    logFilePath: asString(row, "log_file_path"),
    tmuxSessionName: asString(row, "tmux_session_name"),
    tmuxSessionId: asString(row, "tmux_session_id"),
    status: asString(row, "status") as BackgroundAgentSession["status"],
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function activityFromRow(row: Record<string, unknown>): ActivityEvent {
  return {
    id: asString(row, "id"),
    type: asString(row, "type"),
    source: asString(row, "source") as ActivityEvent["source"],
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    workspaceId: row.workspace_id ? asString(row, "workspace_id") : null,
    operationId: row.operation_id ? asString(row, "operation_id") : null,
    message: asString(row, "message"),
    hookOutput: jsonObject<HookOutput>(row, "hook_output"),
    createdAt: asString(row, "created_at"),
  };
}
