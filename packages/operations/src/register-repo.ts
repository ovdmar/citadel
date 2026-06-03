import fs from "node:fs";
import path from "node:path";
import type { ActivityEvent, Repo, Workspace } from "@citadel/contracts";
import { createId, nowIso, repoDisplayName } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { discoverDefaultBranch } from "./helpers.js";

export type RegisterRepoDeps = {
  store: SqliteStore;
  repoDefaults?: {
    setupHookIds: string[];
    teardownHookIds: string[];
  };
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
};

export function registerRepo(
  deps: RegisterRepoDeps,
  input: { rootPath: string; name?: string | undefined; worktreeParent?: string | undefined },
): Repo {
  const now = nowIso();
  const rootPath = path.resolve(input.rootPath);
  if (!fs.existsSync(path.join(rootPath, ".git"))) throw new Error(`Not a git repository: ${rootPath}`);
  const repo: Repo = {
    id: createId("repo"),
    name: input.name || repoDisplayName(rootPath),
    rootPath,
    defaultBranch: discoverDefaultBranch(rootPath),
    defaultRemote: "origin",
    worktreeParent: input.worktreeParent || path.join(path.dirname(rootPath), `${path.basename(rootPath)}-worktrees`),
    setupHookIds: deps.repoDefaults?.setupHookIds ?? [],
    teardownHookIds: deps.repoDefaults?.teardownHookIds ?? [],
    providerIds: ["github-gh", "jira-jtk"],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  const rootWorkspace: Workspace = {
    id: createId("ws"),
    repoId: repo.id,
    name: "main",
    path: repo.rootPath,
    branch: repo.defaultBranch,
    baseBranch: repo.defaultBranch,
    source: "imported",
    kind: "root",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: true,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
  deps.store.exec("BEGIN IMMEDIATE");
  try {
    deps.store.insertRepo(repo);
    deps.activity("repo.registered", "user", `Registered ${repo.name}`, repo.id, null, null);
    deps.store.insertWorkspace(rootWorkspace);
    deps.activity(
      "workspace.root.created",
      "system",
      `Linked root workspace for ${repo.name}`,
      repo.id,
      rootWorkspace.id,
      null,
    );
    deps.store.exec("COMMIT");
  } catch (error) {
    deps.store.exec("ROLLBACK");
    throw error;
  }
  return repo;
}
