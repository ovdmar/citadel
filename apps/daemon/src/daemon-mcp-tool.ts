import { type CitadelConfig, effectiveNotesPath } from "@citadel/config";
import {
  AssignWorkspaceToNamespaceInputSchema,
  CheckoutContextInputSchema,
  CreateAgentSessionInputSchema,
  CreateNamespaceInputSchema,
  CreateRepoInputSchema,
  CreateReviewThreadInputSchema,
  CreateScheduledAgentInputSchema,
  CreateWorkspaceCheckoutInputSchema,
  CreateWorkspaceInputSchema,
  CwdContextInputSchema,
  LaunchAgentInputSchema,
  LaunchArchitectAgentInputSchema,
  LaunchImplementationAgentInputSchema,
  LaunchPmAgentInputSchema,
  LaunchPrototypeAgentInputSchema,
  MarkCheckoutReadyForReviewInputSchema,
  RegisterCheckoutReviewArtifactInputSchema,
  RegisterWorkspacePlanInputSchema,
  ReplyReviewThreadInputSchema,
  ReportPlanDeviationInputSchema,
  type ReviewAuthorKind,
  type ReviewDiffMetadata,
  ReviewThreadIdInputSchema,
  UpdateNamespaceInputSchema,
  UpdateScheduledAgentInputSchema,
  UpdateTicketStatusInputSchema,
  WorkspaceManagerControlInputSchema,
} from "@citadel/contracts";
import { createId, fuzzySearchBlocks } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { type McpToolCall, callMcpTool, serializeWorkspaceResource } from "@citadel/mcp";
import {
  BranchInUseByWorktreeError,
  type OperationService,
  RemoteRefMissingError,
  type ScheduledAgentRunner,
  WorkspaceInUseError,
  WorkspaceNameTakenError,
} from "@citadel/operations";
import { collectProviderHealth } from "@citadel/providers";
import { listRuntimeHealth } from "@citadel/runtimes";
import { resolveCreateAgentSessionInputFromTemplates } from "./agent-session-template-resolver.js";
import type { ProviderCache } from "./app-helpers.js";
import { readLogSlice } from "./log-slice.js";
import { readReviewDiffMetadata } from "./review-diff.js";
import type { ScheduledAgentService } from "./scheduled-agent-service.js";
import { refineScratchpad } from "./scratchpad-refine.js";
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
import { launchStructuredRoleAgent } from "./structured-role-launchers.js";

export type DaemonMcpDeps = {
  config: CitadelConfig;
  store: SqliteStore;
  operations: OperationService;
  scheduledAgents: ScheduledAgentRunner;
  scheduledAgentService: ScheduledAgentService;
  providerCache: ProviderCache;
  emit: (type: string, payload: unknown) => void;
};

export type DaemonMcpCaller = "human" | "mcp" | "manager" | "agent" | "system";
export type DaemonMcpCallContext = {
  actor?: DaemonMcpCaller;
};

export function workspaceResource(store: SqliteStore) {
  const workspaces = store.listWorkspaces();
  return serializeWorkspaceResource({
    repos: store.listRepos(),
    workspaces,
    checkouts: workspaces.flatMap((workspace) => store.listWorkspaceCheckouts(workspace.id)),
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

function reviewAuthorKind(actor: DaemonMcpCaller): ReviewAuthorKind {
  if (actor === "human") return "user";
  if (actor === "system") return "system";
  return "agent";
}

function findReviewMetadataFile(
  metadata: ReviewDiffMetadata,
  bucket: string,
  filePath: string,
  oldPath: string | null,
) {
  return (
    metadata.sections
      .flatMap((section) => section.files)
      .find((file) => file.bucket === bucket && file.path === filePath && file.oldPath === oldPath) ?? null
  );
}

export async function callDaemonMcpTool(deps: DaemonMcpDeps, call: McpToolCall, context: DaemonMcpCallContext = {}) {
  const { config, store, operations, scheduledAgents, scheduledAgentService, providerCache, emit } = deps;
  const actor = context.actor ?? "mcp";
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
  if (call.name === "list_workspace_checkouts") {
    const workspaceId = typeof call.arguments?.workspaceId === "string" ? call.arguments.workspaceId : "";
    if (!workspaceId) return { error: "workspace_id_required" };
    return { checkouts: store.listWorkspaceCheckouts(workspaceId) };
  }
  if (call.name === "create_workspace_checkout") {
    try {
      const result = await operations.createWorkspaceCheckout(
        CreateWorkspaceCheckoutInputSchema.parse(call.arguments ?? {}),
      );
      emit("workspace.updated", { workspaceId: call.arguments?.workspaceId, checkoutId: result.checkoutId });
      return result;
    } catch (error) {
      const structured = structuredWorkspaceError(error);
      if (structured) return structured;
      throw error;
    }
  }
  if (call.name === "register_workspace_plan") {
    const result = operations.registerWorkspacePlan(RegisterWorkspacePlanInputSchema.parse(call.arguments ?? {}), {
      actor,
    });
    if (result.ok)
      emit("workspace.plan.updated", {
        workspaceId: result.planVersion.workspaceId,
        planVersionId: result.planVersion.id,
      });
    return result;
  }
  if (call.name === "get_workspace_plan") {
    return operations.getWorkspacePlan(call.arguments ?? {});
  }
  if (call.name === "get_citadel_context") {
    const input = CwdContextInputSchema.parse(call.arguments ?? {});
    return operations.getCitadelContext(input);
  }
  if (call.name === "report_plan_deviation") {
    const result = operations.reportPlanDeviation(ReportPlanDeviationInputSchema.parse(call.arguments ?? {}));
    if (result.ok)
      emit("workspace.plan.deviation", { workspaceId: result.deviation.workspaceId, deviationId: result.deviation.id });
    return result;
  }
  if (call.name === "start_workspace_manager") {
    const result = operations.startWorkspaceManager(WorkspaceManagerControlInputSchema.parse(call.arguments ?? {}));
    if (result.ok) emit("workspace.manager.updated", { workspaceId: result.manager.workspaceId });
    return result;
  }
  if (call.name === "pause_workspace_manager") {
    const result = operations.pauseWorkspaceManager(WorkspaceManagerControlInputSchema.parse(call.arguments ?? {}));
    if (result.ok) emit("workspace.manager.updated", { workspaceId: result.manager?.workspaceId });
    return result;
  }
  if (call.name === "resume_workspace_manager") {
    const result = operations.resumeWorkspaceManager(WorkspaceManagerControlInputSchema.parse(call.arguments ?? {}));
    if (result.ok) emit("workspace.manager.updated", { workspaceId: result.manager?.workspaceId });
    return result;
  }
  if (call.name === "get_checkout_gate_status") {
    return operations.getCheckoutGateStatus(CheckoutContextInputSchema.parse(call.arguments ?? {}));
  }
  if (call.name === "list_review_threads") {
    const checkoutId = typeof call.arguments?.checkoutId === "string" ? call.arguments.checkoutId : "";
    if (!checkoutId) return { error: "checkout_id_required" };
    const checkout = store.findWorkspaceCheckout(checkoutId);
    if (!checkout) return { error: "checkout_not_found" };
    const metadata = readReviewDiffMetadata(store, checkoutId);
    if (!metadata.reviewScope) return { reviewScope: null, threads: [] };
    return {
      reviewScope: metadata.reviewScope,
      threads: store.listInternalReviewThreads(metadata.reviewScope.id, {
        includeResolved: call.arguments?.includeResolved === true,
        includeOutdated: call.arguments?.includeOutdated === true,
      }),
    };
  }
  if (call.name === "create_review_thread") {
    const checkoutId = typeof call.arguments?.checkoutId === "string" ? call.arguments.checkoutId : "";
    if (!checkoutId) return { error: "checkout_id_required" };
    const checkout = store.findWorkspaceCheckout(checkoutId);
    if (!checkout) return { error: "checkout_not_found" };
    const metadata = readReviewDiffMetadata(store, checkoutId);
    if (!metadata.reviewScope) return { error: "review_scope_required" };
    const parsed = CreateReviewThreadInputSchema.parse({
      authorKind: reviewAuthorKind(actor),
      ...call.arguments,
      checkoutId,
    });
    const file = findReviewMetadataFile(metadata, parsed.bucket, parsed.path, parsed.oldPath ?? null);
    if (!file) return { error: "review_anchor_not_current" };
    if (parsed.anchorKind === "line" && (!parsed.side || !parsed.startLine)) {
      return { error: "line_anchor_requires_side_and_line" };
    }
    const now = new Date().toISOString();
    const threadId = createId("thread");
    const thread = store.createInternalReviewThread(
      {
        id: threadId,
        reviewScopeId: metadata.reviewScope.id,
        kind: "internal",
        status: "open",
        anchorState: "current",
        anchorKind: parsed.anchorKind,
        bucket: parsed.bucket,
        path: parsed.path,
        oldPath: parsed.oldPath ?? null,
        side: parsed.side ?? null,
        startLine: parsed.startLine ?? null,
        endLine: parsed.endLine ?? parsed.startLine ?? null,
        diffIdentity: file.id,
        selectedText: parsed.selectedText ?? null,
        authorKind: parsed.authorKind,
        authorLabel: parsed.authorLabel ?? null,
        providerThreadId: null,
        resolvedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: createId("reply"),
        threadId,
        body: parsed.body,
        authorKind: parsed.authorKind,
        authorLabel: parsed.authorLabel ?? null,
        providerCommentId: null,
        createdAt: now,
        updatedAt: now,
      },
    );
    emit("review.thread.created", { checkoutId, reviewScopeId: metadata.reviewScope.id, threadId: thread.id });
    return { thread };
  }
  if (call.name === "reply_review_thread") {
    const threadId = typeof call.arguments?.threadId === "string" ? call.arguments.threadId : "";
    if (!threadId) return { error: "thread_id_required" };
    const thread = store.findInternalReviewThread(threadId);
    if (!thread) return { error: "review_thread_not_found" };
    const parsed = ReplyReviewThreadInputSchema.parse({
      authorKind: reviewAuthorKind(actor),
      ...call.arguments,
      threadId,
    });
    const now = new Date().toISOString();
    const reply = store.addInternalReviewThreadReply({
      id: createId("reply"),
      threadId,
      body: parsed.body,
      authorKind: parsed.authorKind,
      authorLabel: parsed.authorLabel ?? null,
      providerCommentId: null,
      createdAt: now,
      updatedAt: now,
    });
    const nextThread =
      call.arguments?.resolve === true ? store.setInternalReviewThreadStatus(threadId, "resolved", now) : null;
    emit("review.thread.replied", { reviewScopeId: thread.reviewScopeId, threadId });
    return { reply, thread: nextThread ?? store.findInternalReviewThread(threadId) };
  }
  if (call.name === "resolve_review_thread" || call.name === "reopen_review_thread") {
    const parsed = ReviewThreadIdInputSchema.parse(call.arguments ?? {});
    const thread = store.setInternalReviewThreadStatus(
      parsed.threadId,
      call.name === "resolve_review_thread" ? "resolved" : "open",
      call.name === "resolve_review_thread" ? new Date().toISOString() : null,
    );
    if (!thread) return { error: "review_thread_not_found" };
    emit(call.name === "resolve_review_thread" ? "review.thread.resolved" : "review.thread.reopened", {
      reviewScopeId: thread.reviewScopeId,
      threadId: thread.id,
    });
    return { thread };
  }
  if (call.name === "get_checkout_ticket") {
    const gate = operations.getCheckoutGateStatus(CheckoutContextInputSchema.parse(call.arguments ?? {}));
    return gate.ok ? { ok: true, checkoutId: gate.checkout.id, issue: gate.checkout.issue } : gate;
  }
  if (call.name === "get_checkout_pr") {
    const gate = operations.getCheckoutGateStatus(CheckoutContextInputSchema.parse(call.arguments ?? {}));
    return gate.ok ? { ok: true, checkoutId: gate.checkout.id, pr: gate.checkout.intendedPr } : gate;
  }
  if (call.name === "mark_checkout_ready_for_review") {
    const result = operations.markCheckoutReadyForReview(
      MarkCheckoutReadyForReviewInputSchema.parse(call.arguments ?? {}),
    );
    if (result.ok) emit("checkout.gate.updated", { checkoutId: result.checkout.id });
    return result;
  }
  if (call.name === "register_checkout_review_artifact") {
    const result = operations.registerCheckoutReviewArtifact(
      RegisterCheckoutReviewArtifactInputSchema.parse(call.arguments ?? {}),
      { actor },
    );
    if (result.ok) emit("checkout.gate.updated", { checkoutId: result.artifact.checkoutId });
    return result;
  }
  if (call.name === "update_ticket_status") {
    const result = operations.updateTicketStatus(UpdateTicketStatusInputSchema.parse(call.arguments ?? {}));
    if (result.ok)
      emit("ticket.updated", { workspaceId: call.arguments?.workspaceId, checkoutId: call.arguments?.checkoutId });
    return result;
  }
  if (
    call.name === "launch_pm_agent" ||
    call.name === "launch_architect_agent" ||
    call.name === "launch_implementation_agent" ||
    call.name === "launch_prototype_agent"
  ) {
    const parsed =
      call.name === "launch_pm_agent"
        ? { role: "pm" as const, input: LaunchPmAgentInputSchema.parse(call.arguments ?? {}) }
        : call.name === "launch_architect_agent"
          ? { role: "architect" as const, input: LaunchArchitectAgentInputSchema.parse(call.arguments ?? {}) }
          : call.name === "launch_implementation_agent"
            ? {
                role: "implementation" as const,
                input: LaunchImplementationAgentInputSchema.parse(call.arguments ?? {}),
              }
            : { role: "prototype" as const, input: LaunchPrototypeAgentInputSchema.parse(call.arguments ?? {}) };
    const result = await launchStructuredRoleAgent({ config, store, operations }, parsed, { actor });
    if (result.ok) emit("agent.updated", { workspaceId: result.workspaceId, sessionId: result.session.id });
    return result;
  }
  if (call.name === "start_agent_session") {
    const parsed = CreateAgentSessionInputSchema.parse(call.arguments ?? {});
    const input = await resolveCreateAgentSessionInputFromTemplates(config, parsed);
    const runtime = config.agentRuntimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    const session = await operations.createAgentSession(input, {
      command: runtime.command,
      args: runtime.args,
      displayName: runtime.displayName,
      promptArg: runtime.promptArg ?? null,
      sessionIdArg: runtime.sessionIdArg ?? null,
      resumeArg: runtime.resumeArg ?? null,
      ...(runtime.launchOptions ? { launchOptions: runtime.launchOptions } : {}),
    });
    emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
    return { session };
  }
  if (call.name === "launch_agent") {
    const input = LaunchAgentInputSchema.parse(call.arguments ?? {});
    const runtime = config.agentRuntimes.find((candidate) => candidate.id === input.runtimeId);
    if (!runtime) throw new Error(`Unknown runtime: ${input.runtimeId}`);
    try {
      const result = await operations.launchAgent(input, {
        command: runtime.command,
        args: runtime.args,
        displayName: runtime.displayName,
        promptArg: runtime.promptArg ?? null,
        sessionIdArg: runtime.sessionIdArg ?? null,
        resumeArg: runtime.resumeArg ?? null,
        ...(runtime.launchOptions ? { launchOptions: runtime.launchOptions } : {}),
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
  // The scratchpad paths bundle is computed per call (not captured) because
  // `config` is mutated in place by `PUT /api/config` — see app.ts.
  const spPaths = () => ({ notesPath: effectiveNotesPath(config), dataDir: config.dataDir });
  if (call.name === "read_scratchpad") {
    const p = spPaths();
    return { ...readScratchpad(p), path: p.notesPath };
  }
  if (call.name === "write_scratchpad") {
    if (typeof call.arguments?.content !== "string") return { error: "content_required" };
    try {
      const snapshot = writeScratchpad(spPaths(), call.arguments.content, "mcp:write_scratchpad");
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
      const snapshot = appendScratchpad(spPaths(), call.arguments.content, "mcp:append_scratchpad");
      emit("scratchpad.updated", { updatedAt: snapshot.updatedAt });
      emit("scratchpad.history.updated", { updatedAt: snapshot.updatedAt });
      return snapshot;
    } catch (error) {
      if (error instanceof ScratchpadTooLargeError) return { error: error.message, limit: error.limit };
      throw error;
    }
  }
  if (call.name === "list_blocks") {
    return listBlocks(spPaths());
  }
  if (call.name === "add_block") {
    if (typeof call.arguments?.text !== "string") return { error: "text_required" };
    const position = parsePosition(call.arguments?.position);
    if (position === "invalid") return { error: "position_invalid" };
    const result = addBlock(spPaths(), call.arguments.text, position, "mcp:add_block");
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
      spPaths(),
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
    const result = deleteBlock(spPaths(), call.arguments.id, "mcp:delete_block");
    if ("error" in result) return result;
    emit("scratchpad.updated", { updatedAt: result.snapshot.updatedAt });
    emit("scratchpad.history.updated", { updatedAt: result.snapshot.updatedAt });
    return result.snapshot;
  }
  if (call.name === "fuzzy_search_scratchpad") {
    const query = typeof call.arguments?.query === "string" ? call.arguments.query : "";
    if (query.trim().length === 0) return { error: "query_required" };
    const limitRaw = call.arguments?.limit;
    const limit =
      typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : (undefined as number | undefined);
    const { blocks } = listBlocks(spPaths());
    return { matches: fuzzySearchBlocks(blocks, query, limit) };
  }
  if (call.name === "refine_scratchpad") {
    const args = call.arguments ?? {};
    const input: { repoId?: string; repoName?: string; prompt?: string } = {};
    if (typeof args.repoId === "string") input.repoId = args.repoId;
    if (typeof args.repoName === "string") input.repoName = args.repoName;
    if (typeof args.prompt === "string") input.prompt = args.prompt;
    const refineProviderHealth = async () => collectProviderHealth(config.providers);
    const result = await refineScratchpad({ config, store, operations, providerHealth: refineProviderHealth }, input);
    if (result.ok) {
      emit("workspace.updated", { workspaceId: result.workspaceId, operationId: result.operationId });
      if (result.sessionId) emit("agent.updated", { workspaceId: result.workspaceId, sessionId: result.sessionId });
    }
    return result;
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
  const providerHealth = await collectProviderHealth(config.providers);
  const workspaces = store.listWorkspaces();
  return callMcpTool(call, {
    repos: store.listRepos(),
    workspaces,
    sessions: store.listSessions(),
    operations: store.listOperations(),
    activity: store.listActivity(),
    providerHealth,
    runtimes: listRuntimeHealth(config.agentRuntimes),
    scheduledAgents: scheduledAgents.list(),
    checkouts: workspaces.flatMap((workspace) => store.listWorkspaceCheckouts(workspace.id)),
    workspacePlanVersions: workspaces.flatMap((workspace) => store.listWorkspacePlanVersions(workspace.id)),
    managers: workspaces
      .map((workspace) => store.getWorkspaceManager(workspace.id))
      .filter((manager): manager is NonNullable<typeof manager> => Boolean(manager)),
    namespaces: store.listNamespaces(),
    scratchpadPath: effectiveNotesPath(config),
    // Per-session summary comes from the runtime's own transcript via the
    // adapter dispatcher. mtime pre-filter inside each adapter keeps list
    // calls cheap even on big project dirs.
    sessionPromptSummary: (sessionId) => operations.getSessionPromptSummary(sessionId),
  });
}
