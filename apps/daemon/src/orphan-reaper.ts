// One-shot orphan reaper. Runs once per daemon boot, after runBootRestore.
//
// Background: nothing in the steady-state codepaths leaks tmux sessions.
// Crashes (daemon SEGV, kill -9, OOM-kill) bypass that path and leave behind
// tmux sessions whose DB row was never updated. The 2026-05-27 incident
// accumulated 162 such tmux sessions across two failure modes (broken
// citadel-tmux unit + repeated install retries).
//
// What we reap:
//   - tmux sessions on the citadel socket whose name no DB row references
//     (or whose only references are non-live statuses like `terminated`).
// We do NOT touch sessions whose name matches a DB row in any state — even
// `terminated` rows might still be reachable from Settings → Restore until
// the user clears them. The reaper is conservative; recurring cleanup is
// explicitly out of scope (user request: install/restart only).

import type { SqliteStore } from "@citadel/db";
import { killTmuxSession, listAllTmuxSessions } from "@citadel/terminal";

export type OrphanReaperSummary = {
  tmuxReaped: string[];
};

export async function reapOrphans(deps: {
  store: SqliteStore;
  diagnostics?: { log(category: string, event: string, data?: Record<string, unknown>): void };
  reapTmuxSessions?: boolean;
}): Promise<OrphanReaperSummary> {
  const summary: OrphanReaperSummary = { tmuxReaped: [] };

  // Every tmux session referenced by any DB row, regardless of status —
  // status=terminated rows still have the original tmuxSessionName recorded.
  const referencedTmuxNames = new Set<string>();
  const referencedSockets = new Set<string | null>();
  for (const session of deps.store.listWorkspaceSessions()) {
    if (session.tmuxSessionName) {
      referencedTmuxNames.add(session.tmuxSessionName);
      referencedSockets.add(session.tmuxSocketName ?? null);
    }
  }

  // Tmux side: kill sessions on the socket that no DB row knows about.
  // null = tmux server unreachable → nothing to reap. The DB-membership
  // criterion isn't a tmux probe so it doesn't need retry.
  if (deps.reapTmuxSessions === false) {
    deps.diagnostics?.log("reaper", "tmux.skipped", { reason: "unsafe-shared-socket" });
  } else {
    const sockets = referencedSockets.size > 0 ? referencedSockets : new Set<string | null>([null]);
    for (const socketName of sockets) {
      const liveTmuxNames = listAllTmuxSessions(socketName);
      if (liveTmuxNames === null) {
        deps.diagnostics?.log("reaper", "tmux.unreachable", {
          socketName,
          reason: "list-sessions returned null",
        });
        continue;
      }
      for (const name of liveTmuxNames) {
        if (referencedTmuxNames.has(name)) continue;
        try {
          killTmuxSession(name, socketName);
          summary.tmuxReaped.push(name);
          deps.diagnostics?.log("reaper", "tmux.killed", { tmuxSession: name, socketName, reason: "no-db-row" });
        } catch (err) {
          deps.diagnostics?.log("reaper", "tmux.kill-failed", {
            tmuxSession: name,
            socketName,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
  return summary;
}
