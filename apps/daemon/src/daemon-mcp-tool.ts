import type { CitadelConfig } from "@citadel/config";
import {
  AssignWorkspaceToNamespaceInputSchema,
  CreateAgentSessionInputSchema,
  CreateNamespaceInputSchema,
  CreateRepoInputSchema,
  CreateScheduledAgentInputSchema,
  CreateWorkspaceInputSchema,
  LaunchAgentInputSchema,
  UpdateNamespaceInputSchema,
  UpdateScheduledAgentInputSchema,
} from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type McpToolCall, callMcpTool, serializeWorkspaceResource } from "@citadel/mcp";
import {
  BranchInUseByWorktreeError,
  type OperationService,
  RemoteRefMissingError,
  type ScheduledAgentRunner,
  WorkspaceInUseError,
  WorkspaceNameTakenError,
  addReviewComment,
  deleteReviewComment,
  listReviewComments,
  requestReviewForWorkspace,
  updateReviewComment,
} from "@citadel/operations";
import { collectProviderHealth } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import type { TtydManager } from "@citadel/terminal";
import { readLogSlice } from "./log-slice.js";
import type { ScheduledAgentService } from "./scheduled-agent-service.js";
import {
  ScratchpadTooLargeError,
  addBlock,
  appendScratchpad,
  deleteBlock,
  listBlocks,
  parsePosition,
  readScratchpad,
  updateBlock,
  writeScratchpad,
} from "./scratchpad.js";
import { readWorkspaceDiffSummary } from "./workspace-diff.js";

export type DaemonMcpDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  ttyd: TtydManager;
  scheduledAgents: ScheduledAgentRunner;
  scheduledAgentService: ScheduledAgentService;
  providerCache: Map<string, { expiresAt: number; value: unknown }>;
  emit: (type: string, payload: unknown) => void;
};

export function workspaceResource(store: SqliteStore) {
  return serializeWorkspaceResource({
    repos: store.listRepos(),
    workspaces: store.listWorkspaces(),
    sessions: store.listSessions(),
  });
}

export async function readMcpResource(store: SqliteStore, config: CitadelConfig, uri: string) {
  if (uri === "citadel://repos") return { repos: store.listRepos() };
  if (uri === "citadel://workspaces") return workspaceResource(store);
  if (uri === "citadel://provider-health") return { providerHealth: await collectProviderHealth(config.providers) };
  if (uri === "citadel://activity") return { activity: store.listActivity() };
  if (uri === "citadel://namespaces") return { namespaces: store.listNamespaces() };
  return null;
}

function structuredWorkspaceError(error: unknown): { error: string; [key: string]: unknown } | null {
  if (error instanceof BranchInUseByWorktreeError)
    return { error: "branch_in_use_by_worktree", branch: error.branch, worktreePath: error.worktreePath };
  if (error instanceof RemoteRefMissingError)
    return { error: "remote_ref_missing", branch: error.branch, remote: error.remote };
  if (error instanceof WorkspaceNameTakenError)
    return { error: "workspace_name_taken", repoId: error.repoId, name: error.name };
  if (error instanceof WorkspaceInUseError)
    return { error: "workspace_in_use", workspaceId: error.workspaceId, lifecycle: error.lifecycle };
  return null;
}

export async function callDaemonMcpTool(deps: DaemonMcpDeps, call: McpToolCall) {
  const { config, store, operations, ttyd, scheduledAgents, scheduledAgentService, providerCache, emit } = deps;
  if (call.name === "register_repo") {
    const input = CreateRepoInputSchema.parse(call.arguments ?? {});
    const repo = operations.registerRepo(input);
    emit("repo.updated", { repoId: repo.id, repo });
    return { repo };
  }
  if (call.name === "create_workspace") {
    try {
      const result = await operations.createWorkspace(CreateWorkspaceInputSchema.parse(call.arguments ?? {}));
      emit("workspace.updated", result);
      return result;
    } catch (error) {
      const structured = structuredWorkspaceError(error);
      if (structured) return structured;
      throw error;
    }
  }
  if (call.name === "start_agent_session") {
    const input = CreateAgentSessionInputSchema.parse(call.arguments ?? {});
    const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    const session = await operations.createAgentSession(input, {
      command: runtime.command,
      args: runtime.args,
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? null,
    });
    emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
    return { session };
  }
  if (call.name === "launch_agent") {
    const input = LaunchAgentInputSchema.parse(call.arguments ?? {});
    const runtime = config.runtimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    try {
      const result = await operations.launchAgent(input, {
        command: runtime.command,
        args: runtime.args,
        displayName: runtime.displayName,
        promptArg: runtime.promptArg ?? null,
      });
      emit("workspace.updated", { workspaceId: result.workspaceId, operationId: result.operationId });
      if (result.sessionId) emit("agent.updated", { workspaceId: result.workspaceId, sessionId: result.sessionId });
      return result;
    } catch (error) {
      const structured = structuredWorkspaceError(error);
      if (structured) return structured;
      throw error;
    }
  }
  if (call.name === "stop_agent_session") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? (call.arguments.sessionId as string) : "";
    const result = operations.stopAgentSession({ sessionId });
    ttyd.release(sessionId);
    emit("agent.updated", { sessionId });
    return result;
  }
  if (call.name === "remove_workspace") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? (call.arguments.workspaceId as string) : "";
    const force = call.arguments?.force === true;
    const archiveOnly = call.arguments?.archiveOnly === true;
    const result = await operations.removeWorkspace({ workspaceId, force, archiveOnly });
    emit("workspace.updated", result);
    return result;
  }
  if (call.name === "reconcile") {
    const result = operations.reconcile();
    providerCache.clear();
    emit("state.reconciled", result);
    return result;
  }
  if (call.name === "archive_workspace") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    const result = await operations.removeWorkspace({ workspaceId, archiveOnly: true });
    emit("workspace.updated", result);
    return result;
  }
  if (call.name === "read_agent_output") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    const input: { sessionId: string; lines?: number; maxChars?: number } = { sessionId };
    if (typeof call.arguments?.lines === "number") input.lines = call.arguments.lines;
    if (typeof call.arguments?.maxChars === "number") input.maxChars = call.arguments.maxChars;
    return operations.readAgentTranscript(input);
  }
  if (call.name === "create_namespace") {
    const result = operations.createNamespace(CreateNamespaceInputSchema.parse(call.arguments ?? {}));
    emit("namespace.updated", { namespaceId: result.namespace.id });
    return { namespace: result.namespace, created: result.created };
  }
  if (call.name === "update_namespace") {
    const namespaceId = typeof call.arguments?.namespaceId === "string" ? call.arguments.namespaceId : "";
    if (!namespaceId) return { error: "namespace_id_required" };
    const { namespaceId: _ignored, ...rest } = (call.arguments ?? {}) as Record<string, unknown>;
    const patch = UpdateNamespaceInputSchema.parse(rest);
    const namespace = operations.renameNamespace(namespaceId, patch);
    if (!namespace) return { error: "namespace_not_found", namespaceId };
    emit("namespace.updated", { namespaceId });
    return { namespace };
  }
  if (call.name === "archive_namespace") {
    const namespaceId = typeof call.arguments?.namespaceId === "string" ? call.arguments.namespaceId : "";
    if (!namespaceId) return { error: "namespace_id_required" };
    const namespace = operations.archiveNamespace(namespaceId);
    if (!namespace) return { error: "namespace_not_found", namespaceId };
    emit("namespace.updated", { namespaceId });
    return { namespace };
  }
  if (call.name === "restore_namespace") {
    const namespaceId = typeof call.arguments?.namespaceId === "string" ? call.arguments.namespaceId : "";
    if (!namespaceId) return { error: "namespace_id_required" };
    const namespace = operations.restoreNamespace(namespaceId);
    if (!namespace) return { error: "namespace_not_found", namespaceId };
    emit("namespace.updated", { namespaceId });
    return { namespace };
  }
  if (call.name === "assign_workspace_to_namespace") {
    const input = AssignWorkspaceToNamespaceInputSchema.parse(call.arguments ?? {});
    const result = operations.assignWorkspaceToNamespace(input);
    if (result.assigned) {
      emit("namespace.updated", { workspaceId: input.workspaceId, namespaceId: input.namespaceId });
      emit("workspace.updated", { workspaceId: input.workspaceId });
    }
    return result;
  }
  if (call.name === "list_namespaces") {
    const includeArchived = call.arguments?.includeArchived === true;
    return { namespaces: store.listNamespaces(includeArchived) };
  }
  if (call.name === "read_scratchpad") {
    return readScratchpad(config.dataDir);
  }
  if (call.name === "write_scratchpad") {
    if (typeof call.arguments?.content !== "string") return { error: "content_required" };
    try {
      const snapshot = writeScratchpad(config.dataDir, call.arguments.content, "mcp:write_scratchpad");
      emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
      emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof ScratchpadTooLargeError) return { error: error.message, limit: error.limit };
      throw error;
    }
  }
  if (call.name === "append_scratchpad") {
    if (typeof call.arguments?.content !== "string" || call.arguments.content === "") {
      return { error: "content_required" };
    }
    try {
      const snapshot = appendScratchpad(config.dataDir, call.arguments.content, "mcp:append_scratchpad");
      emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
      emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof ScratchpadTooLargeError) return { error: error.message, limit: error.limit };
      throw error;
    }
  }
  if (call.name === "list_blocks") {
    return listBlocks(config.dataDir);
  }
  if (call.name === "add_block") {
    if (typeof call.arguments?.text !== "string") return { error: "text_required" };
    const position = parsePosition(call.arguments?.position);
    if (position === "invalid") return { error: "position_invalid" };
    const result = addBlock(config.dataDir, call.arguments.text, position, "mcp:add_block");
    if ("error" in result) {
      if (result.error === "scratchpad_too_large") return { error: result.error, limit: 1_000_000 };
      return result;
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    return { block: result.block, ...result.snapshot };
  }
  if (call.name === "update_block") {
    if (typeof call.arguments?.id !== "string" || call.arguments.id === "") return { error: "block_id_required" };
    if (typeof call.arguments?.text !== "string") return { error: "text_required" };
    const deleting = call.arguments.text.trim().length === 0;
    const result = updateBlock(
      config.dataDir,
      call.arguments.id,
      call.arguments.text,
      deleting ? "mcp:delete_block" : "mcp:update_block",
    );
    if ("error" in result) {
      if (result.error === "scratchpad_too_large") return { error: result.error, limit: 1_000_000 };
      return result;
    }
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    if ("block" in result) return { block: result.block, ...result.snapshot };
    return result.snapshot;
  }
  if (call.name === "delete_block") {
    if (typeof call.arguments?.id !== "string" || call.arguments.id === "") return { error: "block_id_required" };
    const result = deleteBlock(config.dataDir, call.arguments.id, "mcp:delete_block");
    if ("error" in result) return result;
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    return result.snapshot;
  }
  if (call.name === "list_deployed_apps") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    if (!workspaceId) return { error: "workspace_id_required" };
    return operations.listDeployedApps({ workspaceId });
  }
  if (call.name === "redeploy_app") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    if (!workspaceId) return { error: "workspace_id_required" };
    const name = typeof call.arguments?.name === "string" ? call.arguments.name : undefined;
    const result = await operations.redeployApp({ workspaceId, appName: name });
    emit("workspace.deploy.redeploy", { workspaceId, operationId: result.operationId, status: result.status });
    return result;
  }
  if (call.name === "send_agent_message") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    const message = typeof call.arguments?.message === "string" ? call.arguments.message : "";
    if (!sessionId) return { ok: false, error: "session_id_required" };
    if (!message) return { ok: false, error: "message_required" };
    const result = await operations.sendAgentMessage({ sessionId, message });
    if (result.ok) emit("agent.updated", { sessionId });
    return result;
  }
  if (call.name === "read_agent_history") {
    const sessionId = typeof call.arguments?.sessionId === "string" ? call.arguments.sessionId : "";
    if (!sessionId) return { ok: false, error: "session_id_required" };
    const input: { sessionId: string; limit?: number; maxChars?: number } = { sessionId };
    if (typeof call.arguments?.limit === "number") input.limit = call.arguments.limit;
    if (typeof call.arguments?.maxChars === "number") input.maxChars = call.arguments.maxChars;
    return operations.readAgentHistory(input);
  }
  if (call.name === "create_scheduled_agent") {
    const parsed = CreateScheduledAgentInputSchema.parse(call.arguments ?? {});
    const result = scheduledAgentService.create(parsed);
    return result.ok ? { scheduledAgent: result.value } : { error: result.error };
  }
  if (call.name === "update_scheduled_agent") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const { id: _ignored, ...rest } = (call.arguments ?? {}) as Record<string, unknown>;
    const parsed = UpdateScheduledAgentInputSchema.parse(rest);
    const result = scheduledAgentService.update(id, parsed);
    return result.ok ? { scheduledAgent: result.value } : { error: result.error };
  }
  if (call.name === "delete_scheduled_agent") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const result = scheduledAgentService.delete(id);
    return result.ok ? { removed: true } : { error: result.error };
  }
  if (call.name === "run_scheduled_agent_now") {
    const id = typeof call.arguments?.id === "string" ? call.arguments.id : "";
    if (!id) return { error: "id_required" };
    const result = await scheduledAgentService.runNow(id);
    if (!result.ok) return { error: result.error };
    const value = result.value;
    if (value.kind === "ran") {
      return {
        status: value.status,
        runId: value.runId,
        message: value.message,
        workspaceId: value.workspaceId,
        sessionId: value.sessionId,
        backgroundSessionId: value.backgroundSessionId,
        scheduledAgent: value.scheduledAgent,
      };
    }
    if (value.kind === "queued") {
      return {
        queued: true,
        runId: value.runId,
        queuePosition: value.queuePosition,
        scheduledAgent: value.scheduledAgent,
      };
    }
    if (value.kind === "skipped_overlap") {
      return { error: "run_already_in_progress", scheduledAgent: value.scheduledAgent };
    }
    return { error: "queue_full", limit: value.limit, scheduledAgent: value.scheduledAgent };
  }
  if (call.name === "list_scheduled_agent_runs") {
    const agentId = typeof call.arguments?.scheduledAgentId === "string" ? call.arguments.scheduledAgentId : "";
    if (!agentId) return { error: "scheduled_agent_id_required" };
    if (!scheduledAgents.find(agentId)) return { error: "scheduled_agent_not_found" };
    const limit = Math.max(1, Math.min(typeof call.arguments?.limit === "number" ? call.arguments.limit : 50, 500));
    const offset = Math.max(0, typeof call.arguments?.offset === "number" ? call.arguments.offset : 0);
    return { runs: store.listScheduledAgentRuns(agentId, { limit, offset }) };
  }
  if (call.name === "read_scheduled_agent_run_log") {
    const runId = typeof call.arguments?.runId === "string" ? call.arguments.runId : "";
    if (!runId) return { error: "run_id_required" };
    const run = store.findScheduledAgentRun(runId);
    if (!run) return { error: "run_not_found" };
    if (!run.logFilePath) return { error: "log_not_available" };
    const offset = typeof call.arguments?.offset === "number" ? call.arguments.offset : 0;
    const maxBytes = typeof call.arguments?.maxBytes === "number" ? call.arguments.maxBytes : undefined;
    const slice = readLogSlice(run.logFilePath, { offset, ...(maxBytes !== undefined ? { maxBytes } : {}) });
    if ("kind" in slice) return { error: "log_file_missing" };
    return slice;
  }
  if (
    call.name === "list_review_comments" ||
    call.name === "add_review_comment" ||
    call.name === "update_review_comment" ||
    call.name === "delete_review_comment" ||
    call.name === "request_review"
  ) {
    return handleReviewTool(deps, call);
  }
  const providerHealth = await collectProviderHealth(config.providers);
  return callMcpTool(call, {
    repos: store.listRepos(),
    workspaces: store.listWorkspaces(),
    sessions: store.listSessions(),
    operations: store.listOperations(),
    activity: store.listActivity(),
    providerHealth,
    runtimes: listRuntimeHealth(config.runtimes),
    scheduledAgents: scheduledAgents.list(),
    namespaces: store.listNamespaces(),
    // Per-session summary comes from the runtime's own transcript via the
    // adapter dispatcher. mtime pre-filter inside each adapter keeps list
    // calls cheap even on big project dirs.
    sessionPromptSummary: (sessionId) => operations.getSessionPromptSummary(sessionId),
  });
}

async function handleReviewTool(deps: DaemonMcpDeps, call: McpToolCall): Promise<unknown> {
  const { store, config } = deps;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const activity = (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
  ) => {
    store.addActivity({
      id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      type,
      source,
      repoId,
      workspaceId,
      operationId: null,
      message,
      hookOutput: null,
      createdAt: new Date().toISOString(),
    });
  };
  const resolveWorkspace = (workspaceId: string) => store.listWorkspaces().find((w) => w.id === workspaceId) ?? null;

  if (call.name === "list_review_comments") {
    const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) return { error: "workspace_not_found" };
    const status = (args.status as "open" | "resolved" | "all" | undefined) ?? "all";
    const includeDeleted = args.includeDeleted === true;
    const comments = listReviewComments({ store, workspaceId, status, includeDeleted });
    return { comments };
  }

  if (call.name === "add_review_comment") {
    // Reject any attempt to spoof author identity. The schema also marks
    // additionalProperties:false, but the in-process dispatcher does not
    // re-validate args against the schema, so we belt-and-braces here:
    // both `author` (the documented schema field) and `runtimeId` (an
    // undocumented field a caller might try to inject) are refused. Until
    // the MCP transport exposes per-client identity, the daemon stamps
    // 'agent:unknown'.
    if ("author" in args || "runtimeId" in args) return { error: "author_not_allowed" };
    const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) return { error: "workspace_not_found" };
    const body = typeof args.body === "string" ? args.body : "";
    if (!body) return { error: "body_required" };
    const filePath = (args.filePath as string | undefined) ?? null;
    const lineStart = (args.lineStart as number | undefined) ?? null;
    const lineEnd = (args.lineEnd as number | undefined) ?? null;
    const side = (args.side as "LEFT" | "RIGHT" | undefined) ?? null;
    const row = addReviewComment({
      store,
      activity,
      workspaceId,
      body,
      author: "agent:unknown",
      repoId: workspace.repoId,
      filePath,
      lineStart,
      lineEnd,
      side,
    });
    return { comment: row };
  }

  if (call.name === "update_review_comment") {
    const id = typeof args.id === "string" ? args.id : "";
    const ifUpdatedAtMatches = typeof args.ifUpdatedAtMatches === "string" ? args.ifUpdatedAtMatches : "";
    if (!id || !ifUpdatedAtMatches) return { error: "invalid_input" };
    const existing = store.getReviewComment(id);
    if (!existing || existing.deletedAt) return { error: "comment_not_found" };
    const workspace = resolveWorkspace(existing.workspaceId);
    const result = updateReviewComment({
      store,
      activity,
      id,
      ...(typeof args.body === "string" ? { body: args.body } : {}),
      ...(args.status === "open" || args.status === "resolved" ? { status: args.status } : {}),
      ifUpdatedAtMatches,
      repoId: workspace?.repoId ?? "",
    });
    if (result.kind === "not-found") return { error: "comment_not_found" };
    if (result.kind === "conflict") return { error: "conflict", latest: result.latest };
    return { comment: result.row };
  }

  if (call.name === "delete_review_comment") {
    const id = typeof args.id === "string" ? args.id : "";
    const ifUpdatedAtMatches = typeof args.ifUpdatedAtMatches === "string" ? args.ifUpdatedAtMatches : "";
    if (!id || !ifUpdatedAtMatches) return { error: "invalid_input" };
    const existing = store.getReviewComment(id);
    if (!existing || existing.deletedAt) return { error: "comment_not_found" };
    const workspace = resolveWorkspace(existing.workspaceId);
    const result = deleteReviewComment({
      store,
      activity,
      id,
      ifUpdatedAtMatches,
      repoId: workspace?.repoId ?? "",
    });
    if (result.kind === "not-found") return { error: "comment_not_found" };
    if (result.kind === "conflict") return { error: "conflict", latest: result.latest };
    return { ok: true };
  }

  if (call.name === "request_review") {
    const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) return { error: "workspace_not_found" };
    const repos = store.listRepos();
    const repo = repos.find((r) => r.id === workspace.repoId);
    if (!repo) return { error: "repo_not_found" };
    const result = await requestReviewForWorkspace({
      store,
      config: { hooks: config.hooks, commandPolicy: config.commandPolicy },
      activity,
      repo,
      workspace,
      diff: readWorkspaceDiffSummary(workspace.id, workspace.path),
    });
    if (result.kind === "no-hook") return { error: "no-hook" };
    if (result.kind === "succeeded") return { run: result.run, output: result.output };
    if (result.kind === "timed-out") return { error: "timed-out", run: result.run };
    return { error: "hook-failed", run: result.run, message: result.error };
  }
  return { error: "unknown_review_tool" };
}
