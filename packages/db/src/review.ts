import type { ReviewComment, ReviewSuggestionRun, ReviewSuggestionsOutput } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { asString } from "./rows.js";

declare module "./index.js" {
  interface SqliteStore {
    listReviewComments(workspaceId: string, opts?: ListReviewCommentsOptions): ReviewComment[];
    getReviewComment(id: string): ReviewComment | null;
    insertReviewComment(input: InsertReviewCommentInput): ReviewComment;
    updateReviewComment(
      id: string,
      patch: ReviewCommentPatch,
      ifUpdatedAtMatches: string,
      now?: string,
    ): ReviewCommentMutationResult;
    softDeleteReviewComment(
      id: string,
      ifUpdatedAtMatches: string,
      now?: string,
    ): ReviewCommentMutationResult;
    insertReviewSuggestionRun(input: InsertReviewSuggestionRunInput): ReviewSuggestionRun;
    latestReviewSuggestionRun(workspaceId: string): ReviewSuggestionRun | null;
  }
}

export type ListReviewCommentsOptions = {
  status?: "open" | "resolved" | "all";
  includeDeleted?: boolean;
  includeArchived?: boolean;
};

export type InsertReviewCommentInput = {
  id: string;
  workspaceId: string;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  side?: "LEFT" | "RIGHT" | null;
  author: string;
  body: string;
  status?: ReviewComment["status"];
  createdAt?: string;
  updatedAt?: string;
};

export type ReviewCommentPatch = {
  body?: string;
  status?: ReviewComment["status"];
};

export type ReviewCommentMutationResult =
  | { kind: "updated"; row: ReviewComment }
  | { kind: "conflict"; latest: ReviewComment }
  | { kind: "not-found" };

export type InsertReviewSuggestionRunInput = Omit<ReviewSuggestionRun, "createdAt"> & {
  createdAt?: string;
};

function reviewCommentFromRow(row: Record<string, unknown>): ReviewComment {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    filePath: row.file_path ? asString(row, "file_path") : null,
    lineStart: row.line_start === null || row.line_start === undefined ? null : Number(row.line_start),
    lineEnd: row.line_end === null || row.line_end === undefined ? null : Number(row.line_end),
    side: row.side ? (asString(row, "side") as "LEFT" | "RIGHT") : null,
    author: asString(row, "author"),
    body: asString(row, "body"),
    status: asString(row, "status") as ReviewComment["status"],
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    deletedAt: row.deleted_at ? asString(row, "deleted_at") : null,
  };
}

function reviewSuggestionRunFromRow(row: Record<string, unknown>): ReviewSuggestionRun {
  const outputJson = row.output_json ? asString(row, "output_json") : null;
  const output: ReviewSuggestionsOutput | null = outputJson
    ? (JSON.parse(outputJson) as ReviewSuggestionsOutput)
    : null;
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    hookId: asString(row, "hook_id"),
    status: asString(row, "status") as ReviewSuggestionRun["status"],
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    exitStatus: row.exit_status === null || row.exit_status === undefined ? null : Number(row.exit_status),
    output,
    stderr: row.stderr ? asString(row, "stderr") : null,
    error: row.error ? asString(row, "error") : null,
    createdAt: asString(row, "created_at"),
  };
}

export const reviewStoreMethods = {
  listReviewComments(this: SqliteStore, workspaceId: string, opts: ListReviewCommentsOptions = {}): ReviewComment[] {
    const { status = "all", includeDeleted = false, includeArchived = false } = opts;
    const clauses: string[] = ["rc.workspace_id = ?"];
    const params: unknown[] = [workspaceId];
    if (!includeDeleted) clauses.push("rc.deleted_at IS NULL");
    if (status !== "all") {
      clauses.push("rc.status = ?");
      params.push(status);
    }
    if (!includeArchived) clauses.push("w.archived_at IS NULL");
    const sql = `SELECT rc.* FROM review_comments rc
                 JOIN workspaces w ON w.id = rc.workspace_id
                 WHERE ${clauses.join(" AND ")}
                 ORDER BY rc.created_at DESC`;
    const rows = this.database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(reviewCommentFromRow);
  },

  getReviewComment(this: SqliteStore, id: string): ReviewComment | null {
    const row = this.database.prepare("SELECT * FROM review_comments WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? reviewCommentFromRow(row) : null;
  },

  insertReviewComment(this: SqliteStore, input: InsertReviewCommentInput): ReviewComment {
    const now = input.createdAt ?? new Date().toISOString();
    const row: ReviewComment = {
      id: input.id,
      workspaceId: input.workspaceId,
      filePath: input.filePath ?? null,
      lineStart: input.lineStart ?? null,
      lineEnd: input.lineEnd ?? null,
      side: input.side ?? null,
      author: input.author,
      body: input.body,
      status: input.status ?? "open",
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
      deletedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO review_comments (id, workspace_id, file_path, line_start, line_end, side, author, body, status, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        row.id,
        row.workspaceId,
        row.filePath,
        row.lineStart,
        row.lineEnd,
        row.side,
        row.author,
        row.body,
        row.status,
        row.createdAt,
        row.updatedAt,
      );
    return row;
  },

  updateReviewComment(
    this: SqliteStore,
    id: string,
    patch: ReviewCommentPatch,
    ifUpdatedAtMatches: string,
    now: string = new Date().toISOString(),
  ): ReviewCommentMutationResult {
    const current = this.getReviewComment(id);
    if (!current || current.deletedAt) return { kind: "not-found" };
    if (current.updatedAt !== ifUpdatedAtMatches) return { kind: "conflict", latest: current };
    const next: ReviewComment = {
      ...current,
      body: patch.body ?? current.body,
      status: patch.status ?? current.status,
      updatedAt: now,
    };
    this.database
      .prepare("UPDATE review_comments SET body = ?, status = ?, updated_at = ? WHERE id = ?")
      .run(next.body, next.status, next.updatedAt, id);
    return { kind: "updated", row: next };
  },

  softDeleteReviewComment(
    this: SqliteStore,
    id: string,
    ifUpdatedAtMatches: string,
    now: string = new Date().toISOString(),
  ): ReviewCommentMutationResult {
    const current = this.getReviewComment(id);
    if (!current || current.deletedAt) return { kind: "not-found" };
    if (current.updatedAt !== ifUpdatedAtMatches) return { kind: "conflict", latest: current };
    const next: ReviewComment = { ...current, updatedAt: now, deletedAt: now };
    this.database
      .prepare("UPDATE review_comments SET updated_at = ?, deleted_at = ? WHERE id = ?")
      .run(next.updatedAt, next.deletedAt, id);
    return { kind: "updated", row: next };
  },

  insertReviewSuggestionRun(this: SqliteStore, input: InsertReviewSuggestionRunInput): ReviewSuggestionRun {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const outputJson = input.output ? JSON.stringify(input.output) : null;
    const row: ReviewSuggestionRun = { ...input, createdAt };
    this.database
      .prepare(
        `INSERT INTO review_suggestion_runs (id, workspace_id, hook_id, status, duration_ms, exit_status, output_json, stderr, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.workspaceId,
        row.hookId,
        row.status,
        row.durationMs,
        row.exitStatus,
        outputJson,
        row.stderr,
        row.error,
        row.createdAt,
      );
    return row;
  },

  latestReviewSuggestionRun(this: SqliteStore, workspaceId: string): ReviewSuggestionRun | null {
    const row = this.database
      .prepare(
        "SELECT * FROM review_suggestion_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(workspaceId) as Record<string, unknown> | undefined;
    return row ? reviewSuggestionRunFromRow(row) : null;
  },
};
