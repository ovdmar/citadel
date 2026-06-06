import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { globalPrCacheKey } from "./global-pr-cache.js";
import { type WorkspaceWatchDirectory, createWorkspaceFsWatchers } from "./workspace-fs-watcher.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpWorkspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-fswatch-"));
  dirs.push(dir);
  const now = new Date().toISOString();
  return {
    id: `ws_${path.basename(dir)}`,
    name: "test",
    dirty: false,
    path: dir,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    repoId: "repo_x",
    branch: "main",
    baseBranch: "main",
    source: "scratch",
    issueKey: null,
    namespaceId: null,
    title: "",
    summary: "",
    pullRequestUrl: null,
    pullRequestNumber: null,
    pullRequestBranch: null,
    lifecycle: "ready",
    storage: "checkout",
    pinned: false,
  } as unknown as Workspace;
}

async function awaitEvent(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("event_timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function createFakeWatchDirectory() {
  type WatchListener = Parameters<WorkspaceWatchDirectory>[1];
  const listeners = new Map<string, Set<WatchListener>>();
  const watchDirectory: WorkspaceWatchDirectory = (absDir, listener) => {
    const set = listeners.get(absDir) ?? new Set<WatchListener>();
    set.add(listener);
    listeners.set(absDir, set);
    const handle = {
      close() {
        set.delete(listener);
        if (set.size === 0) listeners.delete(absDir);
      },
      on() {
        return handle;
      },
    };
    return handle;
  };
  return {
    watchDirectory,
    emit(rootPath: string, rel: string) {
      const relDir = path.dirname(rel);
      const absDir = relDir === "." ? rootPath : path.join(rootPath, relDir);
      for (const listener of listeners.get(absDir) ?? []) listener("change", path.basename(rel));
    },
  };
}

describe("workspace fs watcher", () => {
  it("emits workspace.fsChanged when a tracked file changes", async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws.path, "README.md"), "initial\n");
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(`git:${ws.id}:x`, { expiresAt: Date.now() + 60_000, value: "cached" });
    const events: Array<{ type: string; payload: unknown }> = [];
    const fakeWatch = createFakeWatchDirectory();
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache,
      emit: (type, payload) => events.push({ type, payload }),
      watchDirectory: fakeWatch.watchDirectory,
      debounceMs: 1,
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, "README.md"), "updated\n");
      fakeWatch.emit(ws.path, "README.md");
      await awaitEvent(() => events.some((e) => e.type === "workspace.fsChanged"));
      expect(events).toContainEqual({ type: "workspace.fsChanged", payload: { workspaceId: ws.id } });
      expect(providerCache.has(`git:${ws.id}:x`)).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it("ignores changes inside node_modules", async () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws.path, "node_modules", "noisy"), { recursive: true });
    const events: Array<{ type: string }> = [];
    const fakeWatch = createFakeWatchDirectory();
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
      watchDirectory: fakeWatch.watchDirectory,
      debounceMs: 1,
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, "node_modules", "noisy", "x.js"), "x\n");
      fakeWatch.emit(ws.path, path.join("node_modules", "noisy", "x.js"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("ignores changes inside .git/objects but not .git/index", async () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws.path, ".git", "objects", "ab"), { recursive: true });
    const events: Array<{ type: string }> = [];
    const fakeWatch = createFakeWatchDirectory();
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
      watchDirectory: fakeWatch.watchDirectory,
      debounceMs: 1,
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, ".git", "objects", "ab", "blob"), "x\n");
      fakeWatch.emit(ws.path, path.join(".git", "objects", "ab", "blob"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual([]);
      fs.writeFileSync(path.join(ws.path, ".git", "index"), "fake-index\n");
      fakeWatch.emit(ws.path, path.join(".git", "index"));
      await awaitEvent(() => events.length > 0);
      expect(events[0]?.type).toBe("workspace.fsChanged");
    } finally {
      watcher.close();
    }
  });

  it("busts the workspace global PR cache entry when HEAD moves", async () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws.path, ".git"), { recursive: true });
    fs.writeFileSync(path.join(ws.path, ".git", "HEAD"), "ref: refs/heads/main\n");
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(globalPrCacheKey("owner/repo", 42), { expiresAt: Date.now() + 60_000, value: "cached-pr" });
    const events: Array<{ type: string }> = [];
    const fakeWatch = createFakeWatchDirectory();
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      resolveRepoFullName: () => "owner/repo",
      getWorkspacePrSnapshot: () => ({ prNumber: 42 }),
      providerCache,
      emit: (type) => events.push({ type }),
      watchDirectory: fakeWatch.watchDirectory,
      debounceMs: 1,
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, ".git", "HEAD"), "ref: refs/heads/feature\n");
      fakeWatch.emit(ws.path, path.join(".git", "HEAD"));
      await awaitEvent(() => events.some((e) => e.type === "workspace.fsChanged"));
      expect(providerCache.has(globalPrCacheKey("owner/repo", 42))).toBe(false);
    } finally {
      watcher.close();
    }
  });

  it("stops watching when a workspace is removed via reconcile", async () => {
    const ws = tmpWorkspace();
    let list: Workspace[] = [ws];
    const events: Array<{ type: string }> = [];
    const fakeWatch = createFakeWatchDirectory();
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => list,
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
      watchDirectory: fakeWatch.watchDirectory,
      debounceMs: 1,
    });
    watcher.reconcile();
    try {
      list = [];
      watcher.reconcile();
      fs.writeFileSync(path.join(ws.path, "after-removal.txt"), "x\n");
      fakeWatch.emit(ws.path, "after-removal.txt");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(events).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});
