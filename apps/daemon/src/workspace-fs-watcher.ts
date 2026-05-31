import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "@citadel/contracts";
import { globalPrCacheKeyForWorkspace } from "./global-pr-cache.js";

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
const FALLBACK_POLL_INTERVAL_MS = 250;

type ProviderCache = Map<string, { expiresAt: number; value: unknown }>;

type WorkspaceFsWatcherDeps = {
  listWorkspaces: () => Workspace[];
  resolveRepoFullName?: (repoId: string) => string | null;
  getWorkspacePrSnapshot?: (workspaceId: string) => { prNumber: number | null } | null;
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
  // One workspace = many non-recursive inotify watches (one per non-ignored
  // directory). We avoided fs.watch({recursive:true}) because on Linux that
  // descends into IGNORED_TOP_LEVEL dirs anyway — isIgnored() only filters
  // the *callback*, not the watch installation. With node_modules included
  // a single workspace can hold thousands of watches; tests churning files
  // in node_modules then flood the event loop with ignored callbacks and
  // terminal WebSockets start missing timely reads/writes.
  const watchers = new Map<string, Array<{ close: () => void }>>();
  const debounces = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingHeadBusts = new Set<string>();
  const failed = new Set<string>();

  const onChange = (workspaceId: string) => (rel: string) => {
    if (!rel || isIgnored(rel)) return;
    if (isGitHeadRef(rel)) pendingHeadBusts.add(workspaceId);
    const existing = debounces.get(workspaceId);
    if (existing) clearTimeout(existing);
    debounces.set(
      workspaceId,
      setTimeout(() => {
        debounces.delete(workspaceId);
        bustWorkspaceCaches(deps.providerCache, workspaceId);
        if (pendingHeadBusts.delete(workspaceId)) bustWorkspaceGlobalPrCache(deps, workspaceId);
        deps.emit("workspace.fsChanged", { workspaceId });
      }, DEBOUNCE_MS),
    );
  };

  const watchTree = (rootPath: string, callback: (rel: string) => void): Array<{ close: () => void }> => {
    const acc: Array<{ close: () => void }> = [];
    const walk = (absDir: string, relDir: string) => {
      if (relDir) {
        const parts = relDir.split(path.sep);
        const top = parts[0];
        if (top && IGNORED_TOP_LEVEL.has(top)) return;
        if (top === ".git" && parts[1] && IGNORED_GIT_INTERNAL.has(parts[1])) return;
      }
      try {
        const w = fs.watch(absDir, { persistent: false }, (_eventType, filename) => {
          if (filename == null) return;
          const name = typeof filename === "string" ? filename : String(filename);
          if (!name) return;
          callback(relDir ? path.join(relDir, name) : name);
        });
        w.on("error", () => {
          /* skip errors per-dir; the workspace-level error handler reports the aggregate failure */
        });
        acc.push(w);
      } catch {
        // ENOSPC or perms — skip this dir and continue with siblings.
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          walk(path.join(absDir, entry.name), relDir ? path.join(relDir, entry.name) : entry.name);
        }
      }
    };
    walk(rootPath, "");
    return acc;
  };

  const pollTree = (rootPath: string, callback: (rel: string) => void): { close: () => void } => {
    let previous = snapshotTree(rootPath);
    const timer = setInterval(() => {
      const next = snapshotTree(rootPath);
      for (const [rel, fingerprint] of next) {
        if (previous.get(rel) !== fingerprint) callback(rel);
      }
      for (const rel of previous.keys()) {
        if (!next.has(rel)) callback(rel);
      }
      previous = next;
    }, FALLBACK_POLL_INTERVAL_MS);
    timer.unref();
    return { close: () => clearInterval(timer) };
  };

  const closeFor = (id: string) => {
    const ws = watchers.get(id);
    if (ws) for (const w of ws) w.close();
    watchers.delete(id);
    const d = debounces.get(id);
    if (d) clearTimeout(d);
    debounces.delete(id);
    failed.delete(id);
  };

  const reconcile = () => {
    const current = new Map<string, Workspace>();
    for (const ws of deps.listWorkspaces()) {
      if (ws.archivedAt) continue;
      if (!fs.existsSync(ws.path)) continue;
      current.set(ws.id, ws);
    }
    for (const id of Array.from(watchers.keys())) {
      if (!current.has(id)) closeFor(id);
    }
    for (const [id, ws] of current) {
      if (watchers.has(id) || failed.has(id)) continue;
      try {
        const set = watchTree(ws.path, onChange(id));
        if (set.length === 0) {
          console.error(`[fs-watch] failed to install native watch for ${ws.path}; falling back to polling`);
          watchers.set(id, [pollTree(ws.path, onChange(id))]);
        } else {
          watchers.set(id, set);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[fs-watch] failed to watch ${ws.path}: ${message}`);
        watchers.set(id, [pollTree(ws.path, onChange(id))]);
      }
    }
  };

  const close = () => {
    for (const set of watchers.values()) for (const w of set) w.close();
    watchers.clear();
    for (const d of debounces.values()) clearTimeout(d);
    debounces.clear();
    failed.clear();
  };

  return { reconcile, close };
}

function bustWorkspaceCaches(providerCache: ProviderCache, workspaceId: string) {
  // Only invalidate caches whose freshness actually depends on the local
  // working tree. `vc:` (PR) and `ci:` (workflow runs) are remote state — they
  // don't change because an agent wrote a file. Busting them on every fs blip
  // forces a fresh `gh pr view` on the next batch poll, which under load
  // pushes gh into rate limits and surfaces as PR icons disappearing from the
  // navbar. The 10s / 30s polls already keep this data fresh enough.
  bustCacheByPrefixes(providerCache, [`git:${workspaceId}`, `apps:${workspaceId}`]);
}

function bustWorkspaceGlobalPrCache(deps: WorkspaceFsWatcherDeps, workspaceId: string): void {
  if (!deps.resolveRepoFullName || !deps.getWorkspacePrSnapshot) return;
  const workspace = deps.listWorkspaces().find((candidate) => candidate.id === workspaceId);
  if (!workspace) return;
  const key = globalPrCacheKeyForWorkspace(workspace, {
    resolveRepoFullName: deps.resolveRepoFullName,
    getSnapshot: deps.getWorkspacePrSnapshot,
  });
  if (key) deps.providerCache.delete(key);
}

function isGitHeadRef(rel: string): boolean {
  const parts = rel.split(path.sep);
  return rel === path.join(".git", "HEAD") || (parts[0] === ".git" && parts[1] === "refs" && parts[2] === "heads");
}

function snapshotTree(rootPath: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  const walk = (absDir: string, relDir: string) => {
    if (relDir && isIgnored(relDir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir ? path.join(relDir, entry.name) : entry.name;
      if (isIgnored(rel)) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(abs, rel);
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        snapshot.set(rel, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        /* file may have raced with the scan */
      }
    }
  };
  walk(rootPath, "");
  return snapshot;
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
