import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";
import type { Repo, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import type { GhScheduler } from "./gh-scheduler.js";

const execFileAsync = promisify(execFile);

// Per-repo "did main move?" watcher. Uses `git ls-remote` (local git, NOT gh)
// so no GitHub API quota is consumed. When the default-branch SHA changes,
// flips needsMergeStateRefresh on every open PR for that repo so the next
// scheduler tick re-fetches mergeable / mergeStateStatus. Otherwise the
// conflict-check work is skipped entirely.

const DEFAULT_INTERVAL_MS = 3 * 60_000;
const VIEWER_GRACE_MS = 2 * 60_000;
const LS_REMOTE_TIMEOUT_MS = 10_000;

export type MainWatcherDeps = {
  store: SqliteStore;
  scheduler: GhScheduler;
  hasViewers: () => boolean;
  msSinceLastViewer: () => number;
  // Repo-full-name resolver (e.g., "owner/repo") given a Repo row + a
  // workspace under it. The PR-scheduler keys by full-name-from-PR, so we
  // need a way to derive the same string. Injected so callers can use their
  // existing helper (currently lives in pr-routes).
  resolveRepoFullName: (repo: Repo, workspaces: Workspace[]) => string | null;
  // Seam — tests inject a fake runner; production calls real git ls-remote.
  runLsRemote?: (input: { cwd: string; remote: string; ref: string }) => Promise<string>;
  // Seam — tests inject monotonic clock; production uses Date.now().
  now?: () => number;
};

export type MainWatcherHandle = { stop: () => void };

export type MainWatcherOptions = {
  intervalMs?: number;
  disabled?: boolean;
};

/** Read env knobs once at start; matches the auto-recovery-wiring pattern. */
function readEnvKnobs(): MainWatcherOptions {
  return {
    disabled: process.env.CITADEL_MAIN_WATCHER_DISABLED === "1",
    intervalMs: parsePositiveInt(process.env.CITADEL_MAIN_WATCHER_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Pick a cwd to run `git ls-remote` from. Prefers the repo's rootPath when
 * it exists on disk; otherwise falls back to the first workspace path with a
 * .git directory. Returns null if no valid cwd is reachable. */
export function pickGitCwd(repo: Repo, workspaces: Workspace[]): { cwd: string; reason: "root" | "workspace" } | null {
  if (repo.rootPath && fs.existsSync(`${repo.rootPath}/.git`)) {
    return { cwd: repo.rootPath, reason: "root" };
  }
  for (const ws of workspaces) {
    if (ws.path && fs.existsSync(`${ws.path}/.git`)) {
      return { cwd: ws.path, reason: "workspace" };
    }
  }
  return null;
}

/** Parse `git ls-remote` output line: "<sha>\t<ref>". Returns the SHA or
 * null if the output is empty / malformed. */
export function parseLsRemoteSha(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split("\n")[0] ?? "";
  const tabIdx = firstLine.indexOf("\t");
  if (tabIdx < 0) return null;
  const sha = firstLine.slice(0, tabIdx).trim();
  return /^[0-9a-f]{7,64}$/i.test(sha) ? sha : null;
}

async function defaultLsRemote(input: { cwd: string; remote: string; ref: string }): Promise<string> {
  const result = await execFileAsync("git", ["ls-remote", "--exit-code", input.remote, input.ref], {
    cwd: input.cwd,
    timeout: LS_REMOTE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
  });
  return result.stdout;
}

/** One tick: enumerate active repos, ls-remote each, mark scheduler entries
 * on SHA change. Exported so tests can drive a single tick without spinning
 * the setInterval. */
export async function runMainWatcherTick(
  deps: MainWatcherDeps,
  lastSeenSha: Map<string, string>,
  log: (level: "debug" | "warn", message: string) => void,
): Promise<void> {
  // Viewer gate — match the scheduler's grace window.
  if (!deps.hasViewers() && deps.msSinceLastViewer() > VIEWER_GRACE_MS) return;

  const repos = deps.store.listRepos().filter((r) => !r.archivedAt);
  const allWorkspaces = deps.store.listWorkspaces();
  const runLsRemote = deps.runLsRemote ?? defaultLsRemote;

  for (const repo of repos) {
    const workspaces = allWorkspaces.filter((w) => w.repoId === repo.id && !w.archivedAt);
    if (workspaces.length === 0) continue; // no live workspace = no PRs to refresh
    const cwd = pickGitCwd(repo, workspaces);
    if (!cwd) {
      log("warn", `main-watcher: repo ${repo.id} has no reachable .git cwd; skipping tick`);
      continue;
    }
    if (cwd.reason === "workspace") {
      log("warn", `main-watcher: repo ${repo.id} rootPath unreadable, falling back to workspace ${cwd.cwd}`);
    }
    const remote = repo.defaultRemote || "origin";
    const branch = repo.defaultBranch || "main";
    const ref = `refs/heads/${branch}`;
    let stdout: string;
    try {
      stdout = await runLsRemote({ cwd: cwd.cwd, remote, ref });
    } catch (err) {
      log("debug", `main-watcher: ls-remote failed for ${repo.id} (${remote} ${ref}): ${formatErr(err)}`);
      continue;
    }
    const sha = parseLsRemoteSha(stdout);
    if (!sha) {
      log("debug", `main-watcher: ls-remote returned no SHA for ${repo.id}`);
      continue;
    }
    const repoFullName = deps.resolveRepoFullName(repo, workspaces);
    if (!repoFullName) {
      log("debug", `main-watcher: cannot resolve repoFullName for ${repo.id}`);
      continue;
    }
    const prev = lastSeenSha.get(repoFullName);
    if (prev === sha) continue; // stable — nothing to do
    lastSeenSha.set(repoFullName, sha);
    if (prev !== undefined) {
      // SHA actually moved (vs. first-seen). First-seen does NOT trigger a
      // refresh because the scheduler will already pick up mergeStateStatus
      // on its first per-PR tick.
      deps.scheduler.markRepoMainMoved(repoFullName);
    }
  }
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Start the periodic tick. Returns a stop handle wired to clearInterval.
 * Honors CITADEL_MAIN_WATCHER_DISABLED=1 (returns a no-op stop handle). */
export function startMainWatcher(deps: MainWatcherDeps, options?: MainWatcherOptions): MainWatcherHandle {
  const knobs = { ...readEnvKnobs(), ...options };
  if (knobs.disabled) return { stop: () => {} };
  const intervalMs = knobs.intervalMs ?? DEFAULT_INTERVAL_MS;
  const lastSeenSha = new Map<string, string>();
  const log = (level: "debug" | "warn", message: string): void => {
    if (level === "warn") {
      // eslint-disable-next-line no-console
      console.warn(`[main-watcher] ${message}`);
    }
    // debug-level logging is suppressed unless an explicit env switch is set.
    if (level === "debug" && process.env.CITADEL_MAIN_WATCHER_DEBUG === "1") {
      // eslint-disable-next-line no-console
      console.debug(`[main-watcher] ${message}`);
    }
  };
  let running = false;
  const handle = setInterval(() => {
    if (running) return;
    running = true;
    runMainWatcherTick(deps, lastSeenSha, log)
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[main-watcher] tick failed:", err);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }
  return { stop: () => clearInterval(handle) };
}
