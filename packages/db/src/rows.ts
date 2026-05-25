import type {
  ActivityEvent,
  AgentSession,
  BackgroundAgentSession,
  HookOutput,
  Operation,
  OperationLogEntry,
  Repo,
  ScheduledAgent,
  ScheduledAgentRun,
  Workspace,
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
  return {
    id: asString(row, "id"),
    repoId: asString(row, "repo_id"),
    name: asString(row, "name"),
    path: asString(row, "path"),
    branch: asString(row, "branch"),
    baseBranch: asString(row, "base_branch"),
    source: asString(row, "source") as Workspace["source"],
    kind: ((row.kind as string) ?? "worktree") as Workspace["kind"],
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

export function sessionFromRow(row: Record<string, unknown>): AgentSession {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    runtimeId: asString(row, "runtime_id"),
    displayName: asString(row, "display_name"),
    status: asString(row, "status") as AgentSession["status"],
    transport: asString(row, "transport") as AgentSession["transport"],
    tmuxSessionName: row.tmux_session_name ? asString(row, "tmux_session_name") : null,
    tmuxSessionId: row.tmux_session_id ? asString(row, "tmux_session_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
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
