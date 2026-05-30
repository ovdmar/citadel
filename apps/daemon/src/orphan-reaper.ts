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
  for (const session of deps.store.listSessions()) {
    if (session.tmuxSessionName) referencedTmuxNames.add(session.tmuxSessionName);
  }

  // Tmux side: kill sessions on the socket that no DB row knows about.
  // null = tmux server unreachable → nothing to reap. The DB-membership
  // criterion isn't a tmux probe so it doesn't need retry.
  const liveTmuxNames = deps.reapTmuxSessions === false ? new Set<string>() : listAllTmuxSessions();
  if (deps.reapTmuxSessions === false) {
    deps.diagnostics?.log("reaper", "tmux.skipped", { reason: "unsafe-shared-socket" });
  } else if (liveTmuxNames !== null) {
    for (const name of liveTmuxNames) {
      if (referencedTmuxNames.has(name)) continue;
      try {
        killTmuxSession(name);
        summary.tmuxReaped.push(name);
        deps.diagnostics?.log("reaper", "tmux.killed", { tmuxSession: name, reason: "no-db-row" });
      } catch (err) {
        deps.diagnostics?.log("reaper", "tmux.kill-failed", {
          tmuxSession: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } else {
    deps.diagnostics?.log("reaper", "tmux.unreachable", { reason: "list-sessions returned null" });
  }
  return summary;
}
