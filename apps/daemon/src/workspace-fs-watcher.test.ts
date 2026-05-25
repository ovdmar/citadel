import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceFsWatchers } from "./workspace-fs-watcher.js";

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

describe("workspace fs watcher", () => {
  it("emits workspace.fsChanged when a tracked file changes", async () => {
    const ws = tmpWorkspace();
    fs.writeFileSync(path.join(ws.path, "README.md"), "initial\n");
    const providerCache = new Map<string, { expiresAt: number; value: unknown }>();
    providerCache.set(`git:${ws.id}:x`, { expiresAt: Date.now() + 60_000, value: "cached" });
    const events: Array<{ type: string; payload: unknown }> = [];
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache,
      emit: (type, payload) => events.push({ type, payload }),
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, "README.md"), "updated\n");
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
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, "node_modules", "noisy", "x.js"), "x\n");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(events).toEqual([]);
    } finally {
      watcher.close();
    }
  });

  it("ignores changes inside .git/objects but not .git/index", async () => {
    const ws = tmpWorkspace();
    fs.mkdirSync(path.join(ws.path, ".git", "objects", "ab"), { recursive: true });
    const events: Array<{ type: string }> = [];
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => [ws],
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
    });
    watcher.reconcile();
    try {
      fs.writeFileSync(path.join(ws.path, ".git", "objects", "ab", "blob"), "x\n");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(events).toEqual([]);
      fs.writeFileSync(path.join(ws.path, ".git", "index"), "fake-index\n");
      await awaitEvent(() => events.length > 0);
      expect(events[0]?.type).toBe("workspace.fsChanged");
    } finally {
      watcher.close();
    }
  });

  it("stops watching when a workspace is removed via reconcile", async () => {
    const ws = tmpWorkspace();
    let list: Workspace[] = [ws];
    const events: Array<{ type: string }> = [];
    const watcher = createWorkspaceFsWatchers({
      listWorkspaces: () => list,
      providerCache: new Map(),
      emit: (type) => events.push({ type }),
    });
    watcher.reconcile();
    try {
      list = [];
      watcher.reconcile();
      fs.writeFileSync(path.join(ws.path, "after-removal.txt"), "x\n");
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(events).toEqual([]);
    } finally {
      watcher.close();
    }
  });
});
