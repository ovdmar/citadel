import type { Repo } from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { repoFromRow } from "./rows.js";

declare module "./index.js" {
  interface SqliteStore {
    listRepos(): Repo[];
    insertRepo(repo: Repo): void;
    updateRepo(
      repoId: string,
      patch: Partial<
        Pick<
          Repo,
          | "name"
          | "worktreeParent"
          | "providerRepositoryKey"
          | "showMainWorkspace"
          | "setupHookIds"
          | "teardownHookIds"
          | "providerIds"
          | "deployHookCommand"
        >
      >,
    ): Repo | null;
    archiveRepo(repoId: string): void;
  }
}

export const repoStoreMethods = {
  listRepos(this: SqliteStore): Repo[] {
    return this.database
      .prepare("SELECT * FROM repos WHERE archived_at IS NULL ORDER BY name")
      .all()
      .map((row) => repoFromRow(row as Record<string, unknown>));
  },

  insertRepo(this: SqliteStore, repo: Repo) {
    this.database
      .prepare(
        `INSERT INTO repos (id, name, root_path, default_branch, default_remote, worktree_parent,
          provider_repository_key, show_main_workspace, setup_hook_ids, teardown_hook_ids, provider_ids,
          deploy_hook_command, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        repo.id,
        repo.name,
        repo.rootPath,
        repo.defaultBranch,
        repo.defaultRemote,
        repo.worktreeParent,
        repo.providerRepositoryKey ?? null,
        repo.showMainWorkspace ? 1 : 0,
        JSON.stringify(repo.setupHookIds),
        JSON.stringify(repo.teardownHookIds),
        JSON.stringify(repo.providerIds),
        repo.deployHookCommand ?? null,
        repo.createdAt,
        repo.updatedAt,
        repo.archivedAt ?? null,
      );
  },

  updateRepo(this: SqliteStore, repoId: string, patch: Parameters<SqliteStore["updateRepo"]>[1]): Repo | null {
    const existing = this.database.prepare("SELECT * FROM repos WHERE id = ?").get(repoId) as
      | Record<string, unknown>
      | undefined;
    if (!existing) return null;
    const current = repoFromRow(existing);
    const next: Repo = {
      ...current,
      name: patch.name ?? current.name,
      worktreeParent: patch.worktreeParent ?? current.worktreeParent,
      providerRepositoryKey:
        patch.providerRepositoryKey !== undefined ? patch.providerRepositoryKey : current.providerRepositoryKey,
      showMainWorkspace:
        patch.showMainWorkspace !== undefined ? patch.showMainWorkspace : (current.showMainWorkspace ?? false),
      setupHookIds: patch.setupHookIds ?? current.setupHookIds,
      teardownHookIds: patch.teardownHookIds ?? current.teardownHookIds,
      providerIds: patch.providerIds ?? current.providerIds,
      deployHookCommand: patch.deployHookCommand !== undefined ? patch.deployHookCommand : current.deployHookCommand,
      updatedAt: new Date().toISOString(),
    };
    this.database
      .prepare(
        `UPDATE repos SET name = ?, worktree_parent = ?, provider_repository_key = ?, show_main_workspace = ?,
          setup_hook_ids = ?, teardown_hook_ids = ?, provider_ids = ?, deploy_hook_command = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.worktreeParent,
        next.providerRepositoryKey ?? null,
        next.showMainWorkspace ? 1 : 0,
        JSON.stringify(next.setupHookIds),
        JSON.stringify(next.teardownHookIds),
        JSON.stringify(next.providerIds),
        next.deployHookCommand ?? null,
        next.updatedAt,
        repoId,
      );
    return next;
  },

  archiveRepo(this: SqliteStore, repoId: string) {
    const now = new Date().toISOString();
    this.database.prepare("UPDATE repos SET archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, repoId);
    this.database
      .prepare(
        "UPDATE workspaces SET lifecycle = 'archived', archived_at = ?, updated_at = ? WHERE repo_id = ? AND archived_at IS NULL",
      )
      .run(now, now, repoId);
  },
};
