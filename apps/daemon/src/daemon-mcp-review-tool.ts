import { createId } from "@citadel/core";
import type { McpToolCall } from "@citadel/mcp";
import {
  addReviewComment,
  deleteReviewComment,
  listReviewComments,
  requestReviewForWorkspace,
  updateReviewComment,
} from "@citadel/operations";
import type { DaemonMcpDeps } from "./daemon-mcp-tool.js";
import { readWorkspaceDiffSummary } from "./workspace-diff.js";

export function isReviewTool(name: string) {
  return (
    name === "list_review_comments" ||
    name === "add_review_comment" ||
    name === "update_review_comment" ||
    name === "delete_review_comment" ||
    name === "request_review"
  );
}

export async function handleReviewTool(deps: DaemonMcpDeps, call: McpToolCall): Promise<unknown> {
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
      id: createId("evt"),
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
  const resolveWorkspace = (workspaceId: string) =>
    store.listWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;

  if (call.name === "list_review_comments") {
    const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) return { error: "workspace_not_found" };
    const status = (args.status as "open" | "resolved" | "all" | undefined) ?? "all";
    const comments = listReviewComments({
      store,
      workspaceId,
      status,
      includeDeleted: args.includeDeleted === true,
    });
    return { comments };
  }

  if (call.name === "add_review_comment") {
    if ("author" in args || "runtimeId" in args) return { error: "author_not_allowed" };
    const workspaceId = typeof args.workspaceId === "string" ? args.workspaceId : "";
    const workspace = resolveWorkspace(workspaceId);
    if (!workspace) return { error: "workspace_not_found" };
    const body = typeof args.body === "string" ? args.body : "";
    if (!body) return { error: "body_required" };
    const comment = addReviewComment({
      store,
      activity,
      workspaceId,
      body,
      author: "agent:unknown",
      repoId: workspace.repoId ?? "",
      filePath: (args.filePath as string | undefined) ?? null,
      lineStart: (args.lineStart as number | undefined) ?? null,
      lineEnd: (args.lineEnd as number | undefined) ?? null,
      side: (args.side as "LEFT" | "RIGHT" | undefined) ?? null,
    });
    return { comment };
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
    const repo = store.listRepos().find((candidate) => candidate.id === workspace.repoId);
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
