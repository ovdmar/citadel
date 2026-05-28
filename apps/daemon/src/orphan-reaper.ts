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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3-strike has-session probe. Mirrors the helper in boot-restore.ts; we
// duplicate rather than re-export so the orphan-reaper stays independent
// of boot-restore's module surface. See feedback_reaper_retries.md: no
// session-killing path may trust a single failed tmux probe.
async function hasSessionWithRetries(
  probe: (name: string) => boolean,
  name: string,
  opts: { attempts: number; delayMs: number },
): Promise<boolean> {
  for (let i = 0; i < opts.attempts; i++) {
    if (probe(name)) return true;
    if (i < opts.attempts - 1) await sleep(opts.delayMs);
  }
  return false;
}

export async function reapOrphans(deps: { store: SqliteStore; ttyd: TtydManager }): Promise<OrphanReaperSummary> {
  const summary: OrphanReaperSummary = { tmuxReaped: [], ttydReleased: [] };

  // Every tmux session referenced by any DB row, regardless of status —
  // status=terminated rows still have the original tmuxSessionName recorded.
  const referencedTmuxNames = new Set<string>();
  for (const session of deps.store.listSessions()) {
    if (session.tmuxSessionName) referencedTmuxNames.add(session.tmuxSessionName);
  }

  // Tmux side: kill sessions on the socket that no DB row knows about.
  // null = tmux server unreachable → nothing to reap. The DB-membership
  // criterion isn't a tmux probe so it doesn't need retry — only the
  // ttyd-side existence check below does.
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
  // 3-strike check: a single negative `tmux has-session` is never grounds
  // to kill the ttyd, because under load has-session can return non-zero
  // for a perfectly alive session. Three losses with 250ms between is the
  // floor for "really gone".
  for (const entry of deps.ttyd.list()) {
    const alive = await hasSessionWithRetries(tmuxSessionExists, entry.tmuxSession, { attempts: 3, delayMs: 250 });
    if (!alive) {
      deps.ttyd.release(entry.key);
      summary.ttydReleased.push(entry.key);
    }
  }

  return summary;
}
