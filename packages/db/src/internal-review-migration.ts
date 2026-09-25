type SqliteDatabase = {
  exec(sql: string): void;
};

export function migrateInternalReviewThreads(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS internal_review_scopes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      checkout_id TEXT NOT NULL REFERENCES workspace_checkouts(id) ON DELETE CASCADE,
      repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      provider_repository_key TEXT,
      external_review_id TEXT,
      external_review_number INTEGER,
      external_review_url TEXT,
      base_ref TEXT,
      head_ref TEXT,
      head_sha TEXT,
      provider_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (provider_state IN ('open', 'merged', 'closed', 'unknown')),
      observed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_internal_review_scopes_checkout
      ON internal_review_scopes(checkout_id, updated_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_review_scopes_external_id
      ON internal_review_scopes(provider_type, provider_repository_key, external_review_id)
      WHERE external_review_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_internal_review_scopes_external_number
      ON internal_review_scopes(provider_type, provider_repository_key, external_review_number)
      WHERE external_review_number IS NOT NULL;

    CREATE TABLE IF NOT EXISTS internal_review_threads (
      id TEXT PRIMARY KEY,
      review_scope_id TEXT NOT NULL REFERENCES internal_review_scopes(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'internal' CHECK (kind IN ('internal', 'external')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      anchor_state TEXT NOT NULL DEFAULT 'current' CHECK (anchor_state IN ('current', 'outdated')),
      anchor_kind TEXT NOT NULL CHECK (anchor_kind IN ('line', 'file')),
      bucket TEXT NOT NULL CHECK (bucket IN ('against-base', 'staged', 'unstaged')),
      path TEXT NOT NULL,
      old_path TEXT,
      side TEXT CHECK (side IS NULL OR side IN ('old', 'new')),
      start_line INTEGER,
      end_line INTEGER,
      diff_identity TEXT NOT NULL,
      selected_text TEXT,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
      author_label TEXT,
      provider_thread_id TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_internal_review_threads_scope_status
      ON internal_review_threads(review_scope_id, status, anchor_state);
    CREATE INDEX IF NOT EXISTS idx_internal_review_threads_scope_kind
      ON internal_review_threads(review_scope_id, kind);

    CREATE TABLE IF NOT EXISTS internal_review_thread_replies (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES internal_review_threads(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent', 'system')),
      author_label TEXT,
      provider_comment_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_internal_review_thread_replies_thread
      ON internal_review_thread_replies(thread_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS internal_review_viewed_files (
      id TEXT PRIMARY KEY,
      review_scope_id TEXT NOT NULL REFERENCES internal_review_scopes(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL,
      bucket TEXT NOT NULL CHECK (bucket IN ('against-base', 'staged', 'unstaged')),
      path TEXT NOT NULL,
      old_path TEXT NOT NULL DEFAULT '',
      diff_identity TEXT NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      UNIQUE(review_scope_id, bucket, path, old_path, diff_identity)
    );
    CREATE INDEX IF NOT EXISTS idx_internal_review_viewed_scope
      ON internal_review_viewed_files(review_scope_id);

    INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES
      (20, 'internal-review-threads', datetime('now'));
  `);
}
