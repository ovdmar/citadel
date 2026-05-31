import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HookConfig } from "@citadel/config";
import type { HookDiagnostic, HookOutput, Operation, Repo, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { hookDiagnostic } from "@citadel/hooks";
import {
  killTmuxSession,
  panePidProcess,
  stopBackgroundSessionPipe,
  tmuxPaneDead,
  tmuxSessionExists,
} from "@citadel/terminal";

// Foreground commands that mean "pane is at a shell prompt, agent not
// running". Mirrors the set used in agent-messages.ts and status-monitor.ts.
const SHELL_BINARIES = new Set(["bash", "sh", "zsh", "fish", "dash"]);

export function asObject(payload: unknown) {
  return typeof payload === "object" && payload !== null ? payload : {};
}

export function discoverDefaultBranch(rootPath: string) {
  try {
    const remoteHead = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace("refs/remotes/origin/", "");
    return remoteHead || "main";
  } catch {
    return "main";
  }
}

export function tryRunGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

export function cleanupWorktree(
  repoRoot: string,
  worktreePath: string,
): { action: "removed" | "pruned"; warning?: string } {
  if (fs.existsSync(worktreePath)) {
    try {
      tryRunGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
      return { action: "removed" };
    } catch (error) {
      // Git no longer tracks this path as a worktree (already pruned, or its
      // .git stub was replaced by a real .git dir). The directory itself is
      // still under our managed worktreeParent — rm it ourselves so the
      // workspace can actually be removed, then sweep git's bookkeeping.
      fs.rmSync(worktreePath, { recursive: true, force: true });
      try {
        tryRunGit(repoRoot, ["worktree", "prune"]);
      } catch {
        // best-effort; the workspace is gone from disk either way
      }
      const reason = error instanceof Error ? error.message.trim() : String(error);
      return { action: "removed", warning: `git worktree remove rejected (${reason}); cleaned up directory manually` };
    }
  }
  try {
    tryRunGit(repoRoot, ["worktree", "prune"]);
    return { action: "pruned" };
  } catch (error) {
    return { action: "pruned", warning: error instanceof Error ? error.message : String(error) };
  }
}

export class WorkspaceNameTakenError extends Error {
  constructor(
    readonly repoId: string,
    readonly name: string,
  ) {
    super(`workspace_name_taken: ${name}`);
    this.name = "WorkspaceNameTakenError";
  }
}

export class BranchInUseByWorktreeError extends Error {
  constructor(
    readonly branch: string,
    readonly worktreePath: string,
  ) {
    super(`branch_in_use_by_worktree: ${branch} at ${worktreePath}`);
    this.name = "BranchInUseByWorktreeError";
  }
}

export class RemoteRefMissingError extends Error {
  constructor(
    readonly branch: string,
    readonly remote: string,
  ) {
    super(`remote_ref_missing: ${remote}/${branch}`);
    this.name = "RemoteRefMissingError";
  }
}

export class WorkspaceInUseError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly lifecycle: string,
  ) {
    super(`workspace_in_use: ${workspaceId} lifecycle=${lifecycle}`);
    this.name = "WorkspaceInUseError";
  }
}

export function classifyWorktreeError(message: string): { branch: string; worktreePath: string } | null {
  // Git output: "fatal: 'branch' is already used by worktree at '/path'"
  const match = message.match(/'([^']+)' is already (?:used by|checked out at) worktree at '([^']+)'/);
  if (match) return { branch: match[1] ?? "", worktreePath: match[2] ?? "" };
  return null;
}

export function isUniqueWorkspaceNameViolation(error: unknown) {
  if (!(error instanceof Error)) return false;
  return /UNIQUE constraint failed: workspaces\.repo_id, workspaces\.name/i.test(error.message);
}

export type WorktreeAddResult = { mode: "checkout" | "tracking" | "new-from-base"; startPoint?: string };

// Attach a worktree at workspacePath. existingBranch (when set) is preferred:
// reuse it locally, else pull from remote, else fall back to creating a fresh
// branch off origin/baseBranch (the "brand-new branch" case). When
// existingBranch is null we just create a new branch off origin/baseBranch.
export function addWorktree(
  repoRoot: string,
  workspacePath: string,
  remote: string,
  baseBranch: string,
  branch: string,
  existingBranch: string | null,
): WorktreeAddResult {
  if (existingBranch) {
    try {
      tryRunGit(repoRoot, ["worktree", "add", workspacePath, existingBranch]);
      return { mode: "checkout" };
    } catch {
      if (remoteBranchExists(repoRoot, remote, existingBranch)) {
        tryRunGit(repoRoot, ["worktree", "add", "-B", existingBranch, workspacePath, `${remote}/${existingBranch}`]);
        return { mode: "tracking", startPoint: `${remote}/${existingBranch}` };
      }
      const startPoint = `${remote}/${baseBranch}`;
      tryRunGit(repoRoot, ["worktree", "add", "-b", existingBranch, workspacePath, startPoint]);
      return { mode: "new-from-base", startPoint };
    }
  }
  const startPoint = `${remote}/${baseBranch}`;
  tryRunGit(repoRoot, ["worktree", "add", "-b", branch, workspacePath, startPoint]);
  return { mode: "new-from-base", startPoint };
}

export function remoteBranchExists(cwd: string, remote: string, branch: string) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], {
      cwd,
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}

export function workspaceIsDirty(workspacePath: string) {
  if (!fs.existsSync(workspacePath)) return false;
  const output = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  if (output.trim().length > 0) return true;
  return workspaceHasUnpushedCommits(workspacePath);
}

export function workspaceHasUnpushedCommits(workspacePath: string) {
  if (!fs.existsSync(workspacePath)) return false;
  try {
    execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
      cwd: workspacePath,
      encoding: "utf8",
      stdio: "pipe",
    });
    const aheadOutput = execFileSync("git", ["rev-list", "--count", "@{u}..HEAD"], {
      cwd: workspacePath,
      encoding: "utf8",
    });
    return Number(aheadOutput.trim()) > 0;
  } catch {
    try {
      const unreachable = execFileSync("git", ["rev-list", "HEAD", "--not", "--remotes", "--max-count=1"], {
        cwd: workspacePath,
        encoding: "utf8",
      });
      return unreachable.trim().length > 0;
    } catch {
      return false;
    }
  }
}

// Cap output payload sizes so dirty summaries don't unbounded grow in
// pathological cases (e.g. a worktree with thousands of untracked files).
const DIRTY_SUMMARY_FILE_CAP = 50;
const DIRTY_SUMMARY_COMMIT_CAP = 20;

export type WorkspaceDirtySummary = {
  files: Array<{ status: string; path: string }>;
  unpushedCommits: Array<{ sha: string; subject: string }>;
};

// Companion to workspaceIsDirty: returns the actual change summary so the
// cockpit can show which files / commits are blocking the drop. We re-run
// the underlying git invocations (status + log) rather than threading the
// raw output through workspaceIsDirty so this helper can be called
// independently from any code path that needs to surface the detail.
export function workspaceDirtySummary(workspacePath: string): WorkspaceDirtySummary {
  if (!fs.existsSync(workspacePath)) return { files: [], unpushedCommits: [] };

  const files: WorkspaceDirtySummary["files"] = [];
  try {
    const statusOutput = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: workspacePath,
      encoding: "utf8",
      maxBuffer: 512 * 1024,
    });
    for (const line of statusOutput.split("\n")) {
      if (!line) continue;
      // Porcelain v1 format: 2-char status code, single space, then path.
      // Renames are `R  src -> dst`; we keep the right-hand side for display.
      const status = line.slice(0, 2);
      const rest = line.slice(3);
      const file = rest.includes(" -> ") ? (rest.split(" -> ")[1] ?? rest) : rest;
      files.push({ status, path: file });
      if (files.length >= DIRTY_SUMMARY_FILE_CAP) break;
    }
  } catch {
    // Not a git repo or git unavailable — return empty rather than throwing,
    // so callers can render a defensive fallback message.
  }

  const unpushedCommits: WorkspaceDirtySummary["unpushedCommits"] = [];
  try {
    // Try the upstream-aware path first. If `@{u}` resolves, list commits
    // between upstream and HEAD; otherwise fall through to the rev-list
    // fallback that excludes anything reachable from a remote.
    let logOutput = "";
    try {
      execFileSync("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], {
        cwd: workspacePath,
        encoding: "utf8",
        stdio: "pipe",
      });
      logOutput = execFileSync(
        "git",
        ["log", "--pretty=format:%H%x00%s", `--max-count=${DIRTY_SUMMARY_COMMIT_CAP}`, "@{u}..HEAD"],
        { cwd: workspacePath, encoding: "utf8", maxBuffer: 512 * 1024 },
      );
    } catch {
      logOutput = execFileSync(
        "git",
        ["log", "--pretty=format:%H%x00%s", `--max-count=${DIRTY_SUMMARY_COMMIT_CAP}`, "HEAD", "--not", "--remotes"],
        { cwd: workspacePath, encoding: "utf8", maxBuffer: 512 * 1024 },
      );
    }
    for (const line of logOutput.split("\n")) {
      if (!line) continue;
      const [sha, ...subjectParts] = line.split(" ");
      if (!sha) continue;
      unpushedCommits.push({ sha, subject: subjectParts.join(" ") });
      if (unpushedCommits.length >= DIRTY_SUMMARY_COMMIT_CAP) break;
    }
  } catch {
    // Same as above — return whatever we've collected so far.
  }

  return { files, unpushedCommits };
}

export function withActionHookIds(output: HookOutput, hookId: string): HookOutput {
  return {
    ...output,
    actions: output.actions.map((action) => ({ ...action, hookId: action.hookId ?? hookId })),
  };
}

/**
 * Walk the local SqliteStore and reconcile it with disk reality:
 *  - mark sessions as `unknown(tmux_missing)` (or delete) when their tmux session is gone
 *  - mark workspaces whose worktree directory no longer exists as `failed`
 *  - archive repos whose rootPath no longer exists.
 *
 * Session-status reconciliation here covers the boot-time pass. The periodic
 * 2-second status monitor (startStatusMonitor in status-monitor.ts) catches
 * everything that happens after boot. The two paths share the same canonical
 * enum and the same updateSessionStatus shape.
 */
export function reconcileStore(
  store: SqliteStore,
  activity: (message: string, repoId: string | null) => void,
): {
  sessions: number;
  workspaces: number;
  repos: number;
  deletedSessions: number;
  backgroundSessions: number;
} {
  let sessionCount = 0;
  let workspaceCount = 0;
  let repoCount = 0;
  let deletedSessions = 0;
  let backgroundSessionCount = 0;
  const nowIso = new Date().toISOString();

  // Background sessions: close any in-flight scheduled-agent run rows whose
  // pane is dead (command exited). Uses tmuxPaneDead because background
  // sessions are spawned WITHOUT the wrapper that maintains isAgentLive's
  // sentinel — so we can't use that signal here.
  for (const bg of store.listRunningBackgroundSessions()) {
    const sessionGone = !tmuxSessionExists(bg.tmuxSessionName);
    const paneIsDead = sessionGone || tmuxPaneDead(bg.tmuxSessionName);
    if (!paneIsDead) continue;
    // Stop the pipe-pane stream (no-op if the session is already gone) so a
    // user attaching to the surviving pane (remain-on-exit) doesn't keep
    // appending to the log file.
    if (!sessionGone) {
      try {
        stopBackgroundSessionPipe(bg.tmuxSessionName);
      } catch {
        // best-effort
      }
    }
    store.updateBackgroundSessionStatus(bg.id, "stopped");
    // Close the matching in-flight run row, if any.
    const inFlight = bg.scheduledAgentId ? store.findInFlightScheduledAgentRun(bg.scheduledAgentId) : null;
    if (inFlight && inFlight.backgroundSessionId === bg.id) {
      const fileSize = (() => {
        try {
          return inFlight.logFilePath ? fs.statSync(inFlight.logFilePath).size : 0;
        } catch {
          return 0;
        }
      })();
      // Best-effort outcome inference: if the log file has any bytes, treat
      // as succeeded; if empty, treat as failed (the command produced
      // nothing). v1 trade-off — real exit-code propagation requires the
      // wrapper, which we don't want for background.
      store.recordScheduledAgentRunOutcome(inFlight.id, {
        status: fileSize > 0 ? "succeeded" : "failed",
        endedAt: nowIso,
        message: fileSize > 0 ? "session_ended" : "session_ended_no_output",
      });
    }
    // If the tmux session is now gone, the row's bookkeeping is done. If it
    // survives (remain-on-exit), kill it now — the background mode lifecycle
    // ends with the agent exit, and lingering panes are noise.
    if (!sessionGone) {
      try {
        killTmuxSession(bg.tmuxSessionName);
      } catch {
        // best-effort
      }
    }
    backgroundSessionCount += 1;
  }

  for (const session of store.listSessions()) {
    if (!session.tmuxSessionName) continue;
    if (["stopped", "failed", "unknown"].includes(session.status)) continue;
    if (!tmuxSessionExists(session.tmuxSessionName, session.tmuxSocketName ?? null)) {
      const workspaceExists = store.listWorkspaces().some((workspace) => workspace.id === session.workspaceId);
      if (!workspaceExists) {
        store.deleteSession(session.id);
        deletedSessions += 1;
      } else {
        // Boot-time tmux missing = indeterminate (the daemon just restarted;
        // we can't tell whether tmux was killed externally or whether the
        // pane crashed). The next tick of the periodic monitor will refine.
        store.updateSessionStatus(session.id, {
          status: "unknown",
          statusReason: "daemon_restart_indeterminate",
          lastStatusAt: nowIso,
        });
      }
      sessionCount += 1;
      continue;
    }
    // Shell-first lifecycle: the pane PID is `bash -l`; the agent runs as a
    // child. To detect "agent stopped, shell still here", inspect the
    // foreground process command via tmux. If it's a shell binary, the agent
    // isn't running; mark `idle` (NOT `stopped` — the user can restart the
    // agent in-place via the cockpit Restart button). Critically, this path
    // must NOT mass-flip every session to `stopped` when tmux died and the
    // wrapper's .exit files were written — the wrapper is gone, the .exit
    // files don't get written, and the status-monitor's tmux_missing branch
    // above already handles tmux being unreachable.
    //
    // For background sessions and the legacy raw-spawn path, the pane PID is
    // the command itself; absence of a shell foreground means the command
    // is still running → leave the row alone.
    const pane = panePidProcess(session.tmuxSessionName, session.tmuxSocketName ?? null);
    if (pane === null) {
      // tmux missing → handled by the workspace-membership branch above.
      // We re-checked here just to be paranoid; status-monitor's next tick
      // will mark it unknown if the workspace is still around.
      continue;
    }
    if (SHELL_BINARIES.has(pane.command)) {
      // Foreground is a shell binary. For the `shell` runtime, this is
      // normal ("Plain Terminal" — bash IS the runtime) — leave status alone.
      // For agent runtimes, the agent has exited; reflect as idle (NOT
      // stopped) so the cockpit Restart affordance still applies.
      if (session.runtimeId === "shell") continue;
      // Only update if the cached row says the agent is still active —
      // avoids churning rows that the status-monitor tick already labeled.
      if (session.status === "running" || session.status === "starting") {
        store.updateSessionStatus(session.id, {
          status: "idle",
          statusReason: null,
          statusReasonAt: null,
          lastStatusAt: nowIso,
        });
        sessionCount += 1;
      }
    }
  }
  for (const workspace of store.listWorkspaces()) {
    if (workspace.lifecycle === "ready" && !fs.existsSync(workspace.path)) {
      store.updateWorkspaceLifecycle(workspace.id, "failed");
      workspaceCount += 1;
    }
  }
  for (const repo of store.listRepos()) {
    if (!fs.existsSync(path.join(repo.rootPath, ".git"))) {
      store.archiveRepo(repo.id);
      activity(`Auto-archived ${repo.name} (rootPath missing)`, repo.id);
      repoCount += 1;
      continue;
    }
    // Backfill the non-removable root workspace for repos registered before
    // the root-workspace concept existed.
    const repoWorkspaces = store.listWorkspaces(repo.id);
    const hasRoot = repoWorkspaces.some((workspace) => workspace.kind === "root");
    if (!hasRoot) {
      const now = new Date().toISOString();
      try {
        store.insertWorkspace({
          id: `ws_root_${repo.id}`,
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
        });
        activity(`Linked root workspace for ${repo.name}`, repo.id);
      } catch {
        // ignore — collision (path unique) means another workspace already
        // sits on the repo rootPath; nothing to backfill.
      }
    }
  }
  return {
    sessions: sessionCount,
    workspaces: workspaceCount,
    repos: repoCount,
    deletedSessions,
    backgroundSessions: backgroundSessionCount,
  };
}

export function listHookDiagnostics(input: {
  repo: Repo;
  workspace?: Workspace | null | undefined;
  hooks: HookConfig[];
  appHookIds: string[];
  actionHookIds: string[];
  hookTimeoutMs: number;
}): HookDiagnostic[] {
  const events: Array<HookConfig["event"]> = [
    "workspace.setup",
    "workspace.teardown",
    "workspace.apps",
    "workspace.action",
  ];
  return events.flatMap((event) => {
    const ids =
      event === "workspace.setup"
        ? input.repo.setupHookIds
        : event === "workspace.teardown"
          ? input.repo.teardownHookIds
          : event === "workspace.apps"
            ? input.appHookIds
            : input.actionHookIds;
    const eventHooks = input.hooks.filter((hook) => hook.event === event);
    const filtered = ids.length ? eventHooks.filter((hook) => ids.includes(hook.id)) : eventHooks;
    return filtered.map((hook) =>
      hookDiagnostic({
        hook: {
          id: hook.id,
          event: hook.event,
          command: hook.command,
          args: hook.args,
          cwd: hook.cwd || input.workspace?.path || input.repo.rootPath,
          timeoutMs: input.hookTimeoutMs,
          blocking: hook.blocking,
        },
        enabled: true,
      }),
    );
  });
}

export function cancelOperationInStore(
  store: SqliteStore,
  operationId: string,
  nowIso: () => string,
): { cancelled: boolean; reason: "not_found" | "not_cancellable" | "ok"; operation: Operation | null } {
  const operation = store.findOperation(operationId);
  if (!operation) return { cancelled: false, reason: "not_found", operation: null };
  if (!["queued", "running"].includes(operation.status))
    return { cancelled: false, reason: "not_cancellable", operation };
  const updated: Operation = {
    ...operation,
    status: "cancelled",
    progress: 100,
    message: operation.message ?? "Operation cancelled",
    updatedAt: nowIso(),
  };
  store.upsertOperation(updated);
  return { cancelled: true, reason: "ok", operation: updated };
}
