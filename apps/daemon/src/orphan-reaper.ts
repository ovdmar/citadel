// One-shot orphan reaper. Runs once per daemon boot, after runBootRestore.
//
// Background: nothing in the steady-state codepaths leaks tmux sessions or
// ttyd entries — stopAgentSession kills the tmux pane and releases the ttyd.
// Crashes (daemon SEGV, kill -9, OOM-kill) bypass that path and leave behind
// tmux sessions whose DB row was never updated, plus ttyd entries pointing
// at vanished tmux targets. The 2026-05-27 incident accumulated 162 such
// tmux sessions across two failure modes (broken citadel-tmux unit + repeated
// install retries).
//
// What we reap:
//   - tmux sessions on the citadel socket whose name no DB row references
//     (or whose only references are non-live statuses like `terminated`).
//   - ttyd entries in the manager pointing at a tmux session that no longer
//     exists.
//
// We do NOT touch sessions whose name matches a DB row in any state — even
// `terminated` rows might still be reachable from Settings → Restore until
// the user clears them. The reaper is conservative; recurring cleanup is
// explicitly out of scope (user request: install/restart only).

import type { SqliteStore } from "@citadel/db";
import { type TtydManager, killTmuxSession, listAllTmuxSessions, tmuxSessionExists } from "@citadel/terminal";

export type OrphanReaperSummary = {
  tmuxReaped: string[];
  ttydReleased: string[];
};

export function reapOrphans(deps: { store: SqliteStore; ttyd: TtydManager }): OrphanReaperSummary {
  const summary: OrphanReaperSummary = { tmuxReaped: [], ttydReleased: [] };

  // Every tmux session referenced by any DB row, regardless of status —
  // status=terminated rows still have the original tmuxSessionName recorded.
  const referencedTmuxNames = new Set<string>();
  for (const session of deps.store.listSessions()) {
    if (session.tmuxSessionName) referencedTmuxNames.add(session.tmuxSessionName);
  }

  // Tmux side: kill sessions on the socket that no DB row knows about.
  // null = tmux server unreachable → nothing to reap.
  const liveTmuxNames = listAllTmuxSessions();
  if (liveTmuxNames !== null) {
    for (const name of liveTmuxNames) {
      if (referencedTmuxNames.has(name)) continue;
      try {
        killTmuxSession(name);
        summary.tmuxReaped.push(name);
      } catch {
        // best-effort; skip and continue
      }
    }
  }

  // ttyd side: release manager entries pointing at vanished tmux sessions.
  // ttyd.release() SIGTERMs the process and drops it from the map.
  for (const entry of deps.ttyd.list()) {
    if (!tmuxSessionExists(entry.tmuxSession)) {
      deps.ttyd.release(entry.key);
      summary.ttydReleased.push(entry.key);
    }
  }

  return summary;
}
