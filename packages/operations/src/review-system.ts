import type { CitadelConfig, HookConfig } from "@citadel/config";
import type {
  HookOutput,
  Repo,
  ReviewComment,
  ReviewSuggestionRun,
  ReviewSuggestionsOutput,
  Workspace,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { parseReviewSuggestionsOutput, runCommandHookForDiagnostics } from "@citadel/hooks";
import { commandHook } from "./hooks-runner.js";

type ActivityFn = (
  type: string,
  source: "user" | "system" | "hook",
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
  hookOutput?: HookOutput | null,
) => void;

type ReviewServiceConfig = {
  hooks: HookConfig[];
  commandPolicy: CitadelConfig["commandPolicy"];
};

export type RequestReviewResult =
  | { kind: "no-hook" }
  | { kind: "succeeded"; run: ReviewSuggestionRun; output: ReviewSuggestionsOutput }
  | { kind: "failed"; run: ReviewSuggestionRun; error: string }
  | { kind: "timed-out"; run: ReviewSuggestionRun };

export type RequestReviewInput = {
  store: SqliteStore;
  config: ReviewServiceConfig | undefined;
  activity: ActivityFn;
  repo: Repo;
  workspace: Workspace;
  diff: { files: string[]; addedLines: number; deletedLines: number; truncated: boolean };
};

const TIMEOUT_MARKER = "Hook timed out after";

export async function requestReviewForWorkspace(
  input: RequestReviewInput,
): Promise<RequestReviewResult> {
  const { store, config, activity, repo, workspace, diff } = input;
  const ids = repo.requestReviewHookIds ?? [];
  const hooks = (config?.hooks ?? []).filter(
    (hook) => hook.event === "workspace.requestReview" && ids.includes(hook.id),
  );
  const hook = hooks[0];
  if (!hook) return { kind: "no-hook" };

  const payload = {
    event: "workspace.requestReview" as const,
    workspace,
    repo,
    pr: {
      url: workspace.prUrl,
      branch: workspace.branch,
      baseBranch: workspace.baseBranch,
    },
    diff,
  };
  const startedAt = Date.now();
  const timeoutMs = config?.commandPolicy.hookTimeoutMs ?? 120_000;

  try {
    const result = await runCommandHookForDiagnostics(
      commandHook(hook, workspace.path, config),
      payload,
    );
    const durationMs = result.durationMs;
    if (result.exitStatus !== 0) {
      const stderr = result.stderr.slice(-4000) || null;
      const message = `Hook exited with ${result.exitStatus}`;
      const run = store.insertReviewSuggestionRun({
        id: createId("rsr"),
        workspaceId: workspace.id,
        hookId: hook.id,
        status: "failed",
        durationMs,
        exitStatus: result.exitStatus,
        output: null,
        stderr,
        error: message,
      });
      activity(
        "hook.workspace.requestReview.failed",
        "hook",
        `Hook ${hook.id} failed: ${message}`,
        repo.id,
        workspace.id,
        null,
      );
      return { kind: "failed", run, error: message };
    }
    let parsed: ReviewSuggestionsOutput | null = null;
    try {
      parsed = parseReviewSuggestionsOutput(result.stdout);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid review suggestions payload";
      const run = store.insertReviewSuggestionRun({
        id: createId("rsr"),
        workspaceId: workspace.id,
        hookId: hook.id,
        status: "failed",
        durationMs,
        exitStatus: 0,
        output: null,
        stderr: result.stderr.slice(-4000) || null,
        error: message,
      });
      activity(
        "hook.workspace.requestReview.failed",
        "hook",
        `Hook ${hook.id} returned invalid output: ${message}`,
        repo.id,
        workspace.id,
        null,
      );
      return { kind: "failed", run, error: message };
    }
    const output: ReviewSuggestionsOutput = parsed ?? {
      suggestions: [],
      generatedAt: null,
      metadata: {},
    };
    const run = store.insertReviewSuggestionRun({
      id: createId("rsr"),
      workspaceId: workspace.id,
      hookId: hook.id,
      status: "succeeded",
      durationMs,
      exitStatus: 0,
      output,
      stderr: result.stderr.slice(-4000) || null,
      error: null,
    });
    activity(
      "hook.workspace.requestReview",
      "hook",
      `Hook ${hook.id} returned ${output.suggestions.length} suggestion(s)`,
      repo.id,
      workspace.id,
      null,
    );
    return { kind: "succeeded", run, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hook failed";
    const elapsed = Date.now() - startedAt;
    const isTimeout = message.includes(TIMEOUT_MARKER) || elapsed >= timeoutMs;
    const status: ReviewSuggestionRun["status"] = isTimeout ? "timed_out" : "failed";
    const run = store.insertReviewSuggestionRun({
      id: createId("rsr"),
      workspaceId: workspace.id,
      hookId: hook.id,
      status,
      durationMs: elapsed,
      exitStatus: null,
      output: null,
      stderr: null,
      error: message,
    });
    activity(
      "hook.workspace.requestReview.failed",
      "hook",
      `Hook ${hook.id} ${isTimeout ? "timed out" : "failed"}: ${message}`,
      repo.id,
      workspace.id,
      null,
    );
    return isTimeout ? { kind: "timed-out", run } : { kind: "failed", run, error: message };
  }
}

export type AddReviewCommentInput = {
  store: SqliteStore;
  activity: ActivityFn;
  workspaceId: string;
  body: string;
  author: string;
  repoId: string;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  side?: "LEFT" | "RIGHT" | null;
};

export function addReviewComment(input: AddReviewCommentInput): ReviewComment {
  const id = createId("rc");
  const now = nowIso();
  const row = input.store.insertReviewComment({
    id,
    workspaceId: input.workspaceId,
    author: input.author,
    body: input.body,
    filePath: input.filePath ?? null,
    lineStart: input.lineStart ?? null,
    lineEnd: input.lineEnd ?? null,
    side: input.side ?? null,
    createdAt: now,
    updatedAt: now,
  });
  input.activity(
    "review.comment.added",
    "user",
    `Comment ${row.id} added by ${input.author}`,
    input.repoId,
    input.workspaceId,
    null,
  );
  return row;
}

export type UpdateReviewCommentInput = {
  store: SqliteStore;
  activity: ActivityFn;
  id: string;
  body?: string;
  status?: ReviewComment["status"];
  ifUpdatedAtMatches: string;
  repoId: string;
};

export type UpdateReviewCommentResult =
  | { kind: "updated"; row: ReviewComment }
  | { kind: "conflict"; latest: ReviewComment }
  | { kind: "not-found" };

export function updateReviewComment(input: UpdateReviewCommentInput): UpdateReviewCommentResult {
  const patch: { body?: string; status?: ReviewComment["status"] } = {};
  if (input.body !== undefined) patch.body = input.body;
  if (input.status !== undefined) patch.status = input.status;
  const result = input.store.updateReviewComment(input.id, patch, input.ifUpdatedAtMatches);
  if (result.kind === "updated") {
    const eventType =
      input.status === "resolved" && result.row.status === "resolved"
        ? "review.comment.resolved"
        : "review.comment.updated";
    input.activity(
      eventType,
      "user",
      `Comment ${result.row.id} ${input.status === "resolved" ? "resolved" : "updated"}`,
      input.repoId,
      result.row.workspaceId,
      null,
    );
  }
  return result;
}

export type DeleteReviewCommentInput = {
  store: SqliteStore;
  activity: ActivityFn;
  id: string;
  ifUpdatedAtMatches: string;
  repoId: string;
};

export function deleteReviewComment(input: DeleteReviewCommentInput): UpdateReviewCommentResult {
  const result = input.store.softDeleteReviewComment(input.id, input.ifUpdatedAtMatches);
  if (result.kind === "updated") {
    input.activity(
      "review.comment.deleted",
      "user",
      `Comment ${result.row.id} deleted`,
      input.repoId,
      result.row.workspaceId,
      null,
    );
  }
  return result;
}

export type ListReviewCommentsInput = {
  store: SqliteStore;
  workspaceId: string;
  status?: "open" | "resolved" | "all";
  includeDeleted?: boolean;
};

export function listReviewComments(input: ListReviewCommentsInput): ReviewComment[] {
  const opts: { status?: "open" | "resolved" | "all"; includeDeleted?: boolean } = {};
  if (input.status !== undefined) opts.status = input.status;
  if (input.includeDeleted !== undefined) opts.includeDeleted = input.includeDeleted;
  return input.store.listReviewComments(input.workspaceId, opts);
}
