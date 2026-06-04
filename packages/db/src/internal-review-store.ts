import type {
  InternalReviewScopeSummary,
  InternalReviewThread,
  InternalReviewThreadReply,
  MarkReviewFileViewedInput,
  ReviewAnchorState,
  ReviewThreadStatus,
} from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { asString } from "./rows.js";

declare module "./index.js" {
  interface SqliteStore {
    upsertInternalReviewScope(scope: InternalReviewScopeSummary): InternalReviewScopeSummary;
    findInternalReviewScope(id: string): InternalReviewScopeSummary | null;
    findInternalReviewScopeForCheckout(checkoutId: string): InternalReviewScopeSummary | null;
    listInternalReviewScopes(checkoutId?: string): InternalReviewScopeSummary[];
    createInternalReviewThread(
      thread: Omit<InternalReviewThread, "replies">,
      firstReply: InternalReviewThreadReply,
    ): InternalReviewThread;
    listInternalReviewThreads(
      reviewScopeId: string,
      filters?: { includeResolved?: boolean; includeOutdated?: boolean },
    ): InternalReviewThread[];
    findInternalReviewThread(threadId: string): InternalReviewThread | null;
    addInternalReviewThreadReply(reply: InternalReviewThreadReply): InternalReviewThreadReply;
    setInternalReviewThreadStatus(
      threadId: string,
      status: ReviewThreadStatus,
      resolvedAt?: string | null,
    ): InternalReviewThread | null;
    setInternalReviewThreadAnchorState(threadId: string, anchorState: ReviewAnchorState): InternalReviewThread | null;
    markInternalReviewFileViewed(input: MarkReviewFileViewedInput, updatedAt: string): void;
    countOpenCurrentInternalReviewThreads(reviewScopeId: string): number;
    pruneMergedInternalReviewScopes(): number;
    pruneClosedInternalReviewScopes(cutoffIso: string): number;
  }
}

export const internalReviewStoreMethods = {
  upsertInternalReviewScope(this: SqliteStore, scope: InternalReviewScopeSummary): InternalReviewScopeSummary {
    this.database
      .prepare(
        `INSERT INTO internal_review_scopes (id, workspace_id, checkout_id, repo_id, provider_type,
          provider_repository_key, external_review_id, external_review_number, external_review_url,
          base_ref, head_ref, head_sha, provider_state, observed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           checkout_id = excluded.checkout_id,
           repo_id = excluded.repo_id,
           provider_type = excluded.provider_type,
           provider_repository_key = excluded.provider_repository_key,
           external_review_id = excluded.external_review_id,
           external_review_number = excluded.external_review_number,
           external_review_url = excluded.external_review_url,
           base_ref = excluded.base_ref,
           head_ref = excluded.head_ref,
           head_sha = excluded.head_sha,
           provider_state = excluded.provider_state,
           observed_at = excluded.observed_at,
           updated_at = excluded.updated_at`,
      )
      .run(
        scope.id,
        scope.workspaceId,
        scope.checkoutId,
        scope.repoId,
        scope.providerType,
        scope.providerRepositoryKey ?? null,
        scope.externalReviewId ?? null,
        scope.externalReviewNumber ?? null,
        scope.externalReviewUrl ?? null,
        scope.baseRef ?? null,
        scope.headRef ?? null,
        scope.headSha ?? null,
        scope.providerState,
        scope.observedAt ?? null,
        scope.createdAt,
        scope.updatedAt,
      );
    const next = this.findInternalReviewScope(scope.id);
    if (!next) throw new Error(`internal review scope disappeared: ${scope.id}`);
    return next;
  },

  findInternalReviewScope(this: SqliteStore, id: string): InternalReviewScopeSummary | null {
    const row = this.database.prepare("SELECT * FROM internal_review_scopes WHERE id = ?").get(id);
    return row ? scopeFromRow(row as Record<string, unknown>) : null;
  },

  findInternalReviewScopeForCheckout(this: SqliteStore, checkoutId: string): InternalReviewScopeSummary | null {
    const row = this.database
      .prepare("SELECT * FROM internal_review_scopes WHERE checkout_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(checkoutId);
    return row ? scopeFromRow(row as Record<string, unknown>) : null;
  },

  listInternalReviewScopes(this: SqliteStore, checkoutId?: string): InternalReviewScopeSummary[] {
    const stmt = checkoutId
      ? this.database.prepare("SELECT * FROM internal_review_scopes WHERE checkout_id = ? ORDER BY updated_at DESC")
      : this.database.prepare("SELECT * FROM internal_review_scopes ORDER BY updated_at DESC");
    const rows = (checkoutId ? stmt.all(checkoutId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(scopeFromRow);
  },

  createInternalReviewThread(
    this: SqliteStore,
    thread: Omit<InternalReviewThread, "replies">,
    firstReply: InternalReviewThreadReply,
  ): InternalReviewThread {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      insertThread(this, thread);
      insertReply(this, firstReply);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const next = this.findInternalReviewThread(thread.id);
    if (!next) throw new Error(`internal review thread disappeared: ${thread.id}`);
    return next;
  },

  listInternalReviewThreads(
    this: SqliteStore,
    reviewScopeId: string,
    filters: { includeResolved?: boolean; includeOutdated?: boolean } = {},
  ): InternalReviewThread[] {
    const clauses = ["review_scope_id = ?"];
    const params: unknown[] = [reviewScopeId];
    if (!filters.includeResolved) clauses.push("status = 'open'");
    if (!filters.includeOutdated) clauses.push("anchor_state = 'current'");
    const rows = this.database
      .prepare(`SELECT * FROM internal_review_threads WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC`)
      .all(...params) as Array<Record<string, unknown>>;
    return attachReplies(this, rows.map(threadFromRow));
  },

  findInternalReviewThread(this: SqliteStore, threadId: string): InternalReviewThread | null {
    const row = this.database.prepare("SELECT * FROM internal_review_threads WHERE id = ?").get(threadId);
    const thread = row ? threadFromRow(row as Record<string, unknown>) : null;
    return thread ? { ...thread, replies: listReplies(this, thread.id) } : null;
  },

  addInternalReviewThreadReply(this: SqliteStore, reply: InternalReviewThreadReply): InternalReviewThreadReply {
    insertReply(this, reply);
    return reply;
  },

  setInternalReviewThreadStatus(
    this: SqliteStore,
    threadId: string,
    status: ReviewThreadStatus,
    resolvedAt?: string | null,
  ): InternalReviewThread | null {
    this.database
      .prepare("UPDATE internal_review_threads SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?")
      .run(
        status,
        status === "resolved" ? (resolvedAt ?? new Date().toISOString()) : null,
        new Date().toISOString(),
        threadId,
      );
    return this.findInternalReviewThread(threadId);
  },

  setInternalReviewThreadAnchorState(
    this: SqliteStore,
    threadId: string,
    anchorState: ReviewAnchorState,
  ): InternalReviewThread | null {
    this.database
      .prepare("UPDATE internal_review_threads SET anchor_state = ?, updated_at = ? WHERE id = ?")
      .run(anchorState, new Date().toISOString(), threadId);
    return this.findInternalReviewThread(threadId);
  },

  markInternalReviewFileViewed(this: SqliteStore, input: MarkReviewFileViewedInput, updatedAt: string) {
    this.database
      .prepare(
        `INSERT INTO internal_review_viewed_files (id, review_scope_id, file_id, bucket, path, old_path,
          diff_identity, viewed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(review_scope_id, bucket, path, old_path, diff_identity) DO UPDATE SET
           file_id = excluded.file_id,
           viewed = excluded.viewed,
           updated_at = excluded.updated_at`,
      )
      .run(
        viewedId(input),
        input.reviewScopeId,
        input.fileId,
        input.bucket,
        input.path,
        input.oldPath ?? "",
        input.diffIdentity,
        input.viewed ? 1 : 0,
        updatedAt,
      );
  },

  countOpenCurrentInternalReviewThreads(this: SqliteStore, reviewScopeId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM internal_review_threads
         WHERE review_scope_id = ? AND kind = 'internal' AND status = 'open' AND anchor_state = 'current'`,
      )
      .get(reviewScopeId) as { count: number } | undefined;
    return Number(row?.count ?? 0);
  },

  pruneMergedInternalReviewScopes(this: SqliteStore): number {
    return this.database
      .prepare("DELETE FROM internal_review_scopes WHERE provider_state = 'merged' AND observed_at IS NOT NULL")
      .run().changes;
  },

  pruneClosedInternalReviewScopes(this: SqliteStore, cutoffIso: string): number {
    return this.database
      .prepare(
        `DELETE FROM internal_review_scopes
         WHERE provider_state = 'closed' AND observed_at IS NOT NULL AND observed_at < ?`,
      )
      .run(cutoffIso).changes;
  },
};

function scopeFromRow(row: Record<string, unknown>): InternalReviewScopeSummary {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: asString(row, "checkout_id"),
    repoId: asString(row, "repo_id"),
    providerType: asString(row, "provider_type"),
    providerRepositoryKey: row.provider_repository_key ? asString(row, "provider_repository_key") : null,
    externalReviewId: row.external_review_id ? asString(row, "external_review_id") : null,
    externalReviewNumber:
      row.external_review_number === null || row.external_review_number === undefined
        ? null
        : Number(row.external_review_number),
    externalReviewUrl: row.external_review_url ? asString(row, "external_review_url") : null,
    baseRef: row.base_ref ? asString(row, "base_ref") : null,
    headRef: row.head_ref ? asString(row, "head_ref") : null,
    headSha: row.head_sha ? asString(row, "head_sha") : null,
    providerState: asString(row, "provider_state") as InternalReviewScopeSummary["providerState"],
    observedAt: row.observed_at ? asString(row, "observed_at") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function threadFromRow(row: Record<string, unknown>): Omit<InternalReviewThread, "replies"> {
  return {
    id: asString(row, "id"),
    reviewScopeId: asString(row, "review_scope_id"),
    kind: asString(row, "kind") as InternalReviewThread["kind"],
    status: asString(row, "status") as InternalReviewThread["status"],
    anchorState: asString(row, "anchor_state") as InternalReviewThread["anchorState"],
    anchorKind: asString(row, "anchor_kind") as InternalReviewThread["anchorKind"],
    bucket: asString(row, "bucket") as InternalReviewThread["bucket"],
    path: asString(row, "path"),
    oldPath: row.old_path ? asString(row, "old_path") : null,
    side: row.side ? (asString(row, "side") as InternalReviewThread["side"]) : null,
    startLine: row.start_line === null || row.start_line === undefined ? null : Number(row.start_line),
    endLine: row.end_line === null || row.end_line === undefined ? null : Number(row.end_line),
    diffIdentity: asString(row, "diff_identity"),
    selectedText: row.selected_text ? asString(row, "selected_text") : null,
    authorKind: asString(row, "author_kind") as InternalReviewThread["authorKind"],
    authorLabel: row.author_label ? asString(row, "author_label") : null,
    providerThreadId: row.provider_thread_id ? asString(row, "provider_thread_id") : null,
    resolvedAt: row.resolved_at ? asString(row, "resolved_at") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function replyFromRow(row: Record<string, unknown>): InternalReviewThreadReply {
  return {
    id: asString(row, "id"),
    threadId: asString(row, "thread_id"),
    body: asString(row, "body"),
    authorKind: asString(row, "author_kind") as InternalReviewThreadReply["authorKind"],
    authorLabel: row.author_label ? asString(row, "author_label") : null,
    providerCommentId: row.provider_comment_id ? asString(row, "provider_comment_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function attachReplies(
  store: SqliteStore,
  threads: Array<Omit<InternalReviewThread, "replies">>,
): InternalReviewThread[] {
  return threads.map((thread) => ({ ...thread, replies: listReplies(store, thread.id) }));
}

function listReplies(store: SqliteStore, threadId: string): InternalReviewThreadReply[] {
  const rows = store.database
    .prepare("SELECT * FROM internal_review_thread_replies WHERE thread_id = ? ORDER BY created_at ASC")
    .all(threadId) as Array<Record<string, unknown>>;
  return rows.map(replyFromRow);
}

function insertThread(store: SqliteStore, thread: Omit<InternalReviewThread, "replies">) {
  store.database
    .prepare(
      `INSERT INTO internal_review_threads (id, review_scope_id, kind, status, anchor_state, anchor_kind, bucket,
        path, old_path, side, start_line, end_line, diff_identity, selected_text, author_kind, author_label,
        provider_thread_id, resolved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      thread.id,
      thread.reviewScopeId,
      thread.kind,
      thread.status,
      thread.anchorState,
      thread.anchorKind,
      thread.bucket,
      thread.path,
      thread.oldPath ?? null,
      thread.side ?? null,
      thread.startLine ?? null,
      thread.endLine ?? null,
      thread.diffIdentity,
      thread.selectedText ?? null,
      thread.authorKind,
      thread.authorLabel ?? null,
      thread.providerThreadId ?? null,
      thread.resolvedAt ?? null,
      thread.createdAt,
      thread.updatedAt,
    );
}

function insertReply(store: SqliteStore, reply: InternalReviewThreadReply) {
  store.database
    .prepare(
      `INSERT INTO internal_review_thread_replies (id, thread_id, body, author_kind, author_label,
        provider_comment_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      reply.id,
      reply.threadId,
      reply.body,
      reply.authorKind,
      reply.authorLabel ?? null,
      reply.providerCommentId ?? null,
      reply.createdAt,
      reply.updatedAt,
    );
}

function viewedId(input: MarkReviewFileViewedInput): string {
  return `viewed:${input.reviewScopeId}:${input.bucket}:${input.path}:${input.oldPath ?? ""}:${input.diffIdentity}`;
}
