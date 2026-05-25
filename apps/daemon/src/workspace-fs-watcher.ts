import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";

const IGNORED_TOP_LEVEL = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
  ".next",
  ".svelte-kit",
  ".nuxt",
  ".turbo",
  ".cache",
  ".pnpm-store",
  "target",
  ".citadel",
]);
const IGNORED_GIT_INTERNAL = new Set(["objects", "logs", "lfs", "hooks"]);
const DEBOUNCE_MS = 350;

type ProviderCache = Map<string, { expiresAt: number; value: unknown }>;

type WorkspaceFsWatcherDeps = {
  listWorkspaces: () => Workspace[];
  providerCache: ProviderCache;
  emit: (type: string, payload: unknown) => void;
};

export function bustCacheByPrefixes(providerCache: ProviderCache, prefixes: string[]): number {
  let removed = 0;
  for (const key of Array.from(providerCache.keys())) {
    if (prefixes.some((prefix) => key.startsWith(prefix))) {
      providerCache.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export function createWorkspaceFsWatchers(deps: WorkspaceFsWatcherDeps) {
  const watchers = new Map<string, fs.FSWatcher>();
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  const failed = new Set<string>();

  const onChange = (workspaceId: string) => (_eventType: string, filename: string | Buffer | null) => {
    if (!filename) return;
    const rel = typeof filename === "string" ? filename : filename.toString();
    if (isIgnored(rel)) return;
    const existing = debounces.get(workspaceId);
    if (existing) clearTimeout(existing);
    debounces.set(
      workspaceId,
      setTimeout(() => {
        debounces.delete(workspaceId);
        bustWorkspaceCaches(deps.providerCache, workspaceId);
        deps.emit("workspace.fsChanged", { workspaceId });
      }, DEBOUNCE_MS),
    );
  };

  const reconcile = () => {
    const current = new Map<string, Workspace>();
    for (const ws of deps.listWorkspaces()) {
      if (ws.archivedAt) continue;
      if (!fs.existsSync(ws.path)) continue;
      current.set(ws.id, ws);
    }
    for (const [id, watcher] of watchers) {
      if (!current.has(id)) {
        watcher.close();
        watchers.delete(id);
        const d = debounces.get(id);
        if (d) clearTimeout(d);
        debounces.delete(id);
        failed.delete(id);
      }
    }
    for (const [id, ws] of current) {
      if (watchers.has(id) || failed.has(id)) continue;
      try {
        const watcher = fs.watch(ws.path, { recursive: true, persistent: false }, onChange(id));
        watcher.on("error", (err) => {
          console.error(`[fs-watch] ${id}: ${err instanceof Error ? err.message : err}`);
          watchers.delete(id);
          failed.add(id);
        });
        watchers.set(id, watcher);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fs-watch] failed to watch ${ws.path}: ${message}`);
        failed.add(id);
      }
    }
  };

  const close = () => {
    for (const [, watcher] of watchers) watcher.close();
    watchers.clear();
    for (const [, d] of debounces) clearTimeout(d);
    debounces.clear();
    failed.clear();
  };

  return { reconcile, close };
}

function bustWorkspaceCaches(providerCache: ProviderCache, workspaceId: string) {
  bustCacheByPrefixes(providerCache, [
    `git:${workspaceId}`,
    `vc:${workspaceId}`,
    `ci:${workspaceId}`,
    `apps:${workspaceId}`,
  ]);
}

function isIgnored(rel: string): boolean {
  if (!rel) return false;
  const parts = rel.split(path.sep);
  const top = parts[0];
  if (!top) return false;
  if (IGNORED_TOP_LEVEL.has(top)) return true;
  if (top === ".git") {
    const sub = parts[1];
    if (sub && IGNORED_GIT_INTERNAL.has(sub)) return true;
  }
  return false;
}
