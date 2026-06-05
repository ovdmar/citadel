import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeServer,
  createFixture as createFixtureBase,
  createGitFixtureWithRemote,
  createGitRepo,
  getJson,
  listen,
  postJson,
} from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("config/repo/workspace routes", () => {
  it("completes filesystem paths for the add-repo autocomplete", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitRepo(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const parent = path.dirname(repoPath);
      const basename = path.basename(repoPath);
      const dirPrefix = `${parent}/`;
      const dirListing = await getJson<{
        baseDir: string;
        entries: Array<{ name: string; path: string; isGit: boolean }>;
      }>(`${baseUrl}/api/fs/complete?prefix=${encodeURIComponent(dirPrefix)}`);
      expect(dirListing.baseDir).toBe(path.resolve(parent));
      const match = dirListing.entries.find((entry) => entry.name === basename);
      expect(match).toBeTruthy();
      expect(match?.isGit).toBe(true);

      const filtered = await getJson<{ entries: Array<{ name: string; isGit: boolean }> }>(
        `${baseUrl}/api/fs/complete?prefix=${encodeURIComponent(path.join(parent, basename.slice(0, 1)))}`,
      );
      expect(filtered.entries.find((entry) => entry.name === basename)).toBeTruthy();

      const tilde = await getJson<{ baseDir: string }>(`${baseUrl}/api/fs/complete?prefix=~%2F`);
      expect(tilde.baseDir).toBe(os.homedir());
    } finally {
      await closeServer(server);
    }
  });

  it("creates structured workspace Homes and checkouts through REST", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const registered = await postJson<{ repo: Repo }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "citadel",
      });
      expect(registered.repo).toMatchObject({ showMainWorkspace: false });
      const home = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces/home`, {
        name: "Feature Home",
        source: "scratch",
      });
      const stateAfterHome = await getJson<{ workspaces: Workspace[] }>(`${baseUrl}/api/workspaces`);
      const workspace = stateAfterHome.workspaces.find((entry) => entry.id === home.workspaceId);
      expect(workspace).toMatchObject({
        repoId: null,
        kind: "root",
        mode: "structured",
        name: "Feature Home",
      });
      expect(workspace?.rootPath).toContain(path.join(fixture.config.dataDir, "structured-workspaces"));
      expect(fs.existsSync(path.join(workspace?.rootPath ?? "", ".citadel", "workspace.json"))).toBe(true);

      const checkout = await postJson<{ workspaceId: string; checkoutId: string }>(
        `${baseUrl}/api/workspaces/${home.workspaceId}/checkouts`,
        {
          repoId: registered.repo.id,
          name: "api",
          displayName: "API review",
          branch: "feature/api",
          source: "default_branch",
        },
      );
      expect(checkout.workspaceId).toBe(home.workspaceId);
      const state = await getJson<{ checkouts: WorktreeCheckout[] }>(`${baseUrl}/api/state`);
      expect(state.checkouts).toContainEqual(
        expect.objectContaining({
          id: checkout.checkoutId,
          workspaceId: home.workspaceId,
          repoId: registered.repo.id,
          name: "api",
          displayName: "API review",
          branch: "feature/api",
        }),
      );

      const renameResponse = await fetch(
        `${baseUrl}/api/workspaces/${home.workspaceId}/checkouts/${checkout.checkoutId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ displayName: "Payments UI" }),
        },
      );
      expect(renameResponse.ok, await renameResponse.text()).toBe(true);
      const stateAfterRename = await getJson<{ checkouts: WorktreeCheckout[] }>(`${baseUrl}/api/state`);
      expect(stateAfterRename.checkouts.find((candidate) => candidate.id === checkout.checkoutId)).toMatchObject({
        name: "api",
        displayName: "Payments UI",
      });
    } finally {
      await closeServer(server);
    }
  });

  it("persists main repo workspace visibility through repo patch", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const registered = await postJson<{ repo: Repo }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "citadel",
      });
      expect(registered.repo.showMainWorkspace).toBe(false);

      const response = await fetch(`${baseUrl}/api/repos/${registered.repo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showMainWorkspace: true }),
      });
      expect(response.ok, await response.text()).toBe(true);

      const state = await getJson<{ repos: Repo[] }>(`${baseUrl}/api/state`);
      expect(state.repos.find((repo) => repo.id === registered.repo.id)?.showMainWorkspace).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it("backfills owner/repo labels for existing registered repos on startup", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/ovdmar/citadel.git"], {
      cwd: repoPath,
      stdio: "pipe",
    });
    fixture.store.insertRepo({
      id: "repo_existing",
      name: "citadel",
      rootPath: repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      providerRepositoryKey: null,
      showMainWorkspace: false,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-06-03T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
      archivedAt: null,
    });

    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const state = await getJson<{ repos: Repo[] }>(`${baseUrl}/api/state`);
      expect(state.repos.find((repo) => repo.id === "repo_existing")?.providerRepositoryKey).toBe("ovdmar/citadel");
    } finally {
      await closeServer(server);
    }
  });

  it("removes an individual structured checkout through REST", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const registered = await postJson<{ repo: Repo }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "citadel",
      });
      const home = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces/home`, {
        name: "Feature Home",
        source: "scratch",
      });
      const checkout = await postJson<{ workspaceId: string; checkoutId: string }>(
        `${baseUrl}/api/workspaces/${home.workspaceId}/checkouts`,
        {
          repoId: registered.repo.id,
          name: "api",
          branch: "feature/api",
          source: "default_branch",
        },
      );

      const response = await fetch(`${baseUrl}/api/workspaces/${home.workspaceId}/checkouts/${checkout.checkoutId}`, {
        method: "DELETE",
      });
      expect(response.status).toBe(202);
      const state = await getJson<{ workspaces: Workspace[]; checkouts: WorktreeCheckout[] }>(`${baseUrl}/api/state`);
      expect(state.workspaces.find((workspace) => workspace.id === home.workspaceId)).toBeTruthy();
      expect(state.checkouts.find((candidate) => candidate.id === checkout.checkoutId)).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it("generates unique names and branches for repeated blank structured worktree creates", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitFixtureWithRemote(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const registered = await postJson<{ repo: Repo }>(`${baseUrl}/api/repos`, {
        rootPath: repoPath,
        name: "citadel",
      });

      const firstHome = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces/home`, {
        name: "",
        source: "scratch",
      });
      const firstCheckout = await postJson<{ workspaceId: string; checkoutId: string }>(
        `${baseUrl}/api/workspaces/${firstHome.workspaceId}/checkouts`,
        {
          repoId: registered.repo.id,
          source: "default_branch",
        },
      );

      const secondHome = await postJson<{ workspaceId: string }>(`${baseUrl}/api/workspaces/home`, {
        name: "",
        source: "scratch",
      });
      const secondCheckout = await postJson<{ workspaceId: string; checkoutId: string }>(
        `${baseUrl}/api/workspaces/${secondHome.workspaceId}/checkouts`,
        {
          repoId: registered.repo.id,
          source: "default_branch",
        },
      );

      const state = await getJson<{ workspaces: Workspace[]; checkouts: WorktreeCheckout[] }>(`${baseUrl}/api/state`);
      const createdHomes = state.workspaces.filter((workspace) =>
        [firstHome.workspaceId, secondHome.workspaceId].includes(workspace.id),
      );
      const createdCheckouts = state.checkouts.filter((checkout) =>
        [firstCheckout.checkoutId, secondCheckout.checkoutId].includes(checkout.id),
      );
      expect(createdHomes.map((workspace) => workspace.name)).not.toContain("workspace");
      expect(new Set(createdHomes.map((workspace) => workspace.name)).size).toBe(2);
      expect(createdCheckouts.map((checkout) => checkout.name)).toEqual(["citadel", "citadel"]);
      expect(new Set(createdCheckouts.map((checkout) => checkout.branch)).size).toBe(2);
      expect(createdCheckouts.map((checkout) => checkout.name)).not.toEqual(
        createdHomes.map((workspace) => workspace.name),
      );
    } finally {
      await closeServer(server);
    }
  });
});
