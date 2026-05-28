// Boot-time auto-restore. Runs once shortly after the daemon comes up, walks
// the same candidate list the Settings → Restore panel uses, and resumes
// every conversation that died "recently" (within RECENT_WINDOW_MS) without
// asking the user. The cockpit banner then surfaces "Restored N sessions
// from previous run" so the user sees what happened.
//
// Why automatic (vs. manual click-through): after a power loss or daemon
// crash the user wants to be back at their work, not navigating Settings.
// Sessions that were "stopped" by an explicit user action are not at risk
// here — stopAgentSession DELETES the row outright, so it doesn't appear
// in collectRestoreCandidates. The only rows that show up are abnormal
// terminations.
//
// Disabled via CITADEL_DISABLE_BOOT_RESTORE=1 for operators who want to
// keep the cockpit silent on boot. Restore UI in Settings still works.

import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { listAllTmuxSessions, tmuxSessionExists } from "@citadel/terminal";
import { type RestoreCandidate, collectRestoreCandidates } from "./restore-routes.js";

// Statuses that collectRestoreCandidates treats as "live" — sessions in any
// of these states are excluded from the restore-candidate list because their
// tmux pane is presumed alive. After a fresh boot (or any kill-server event)
// the DB rows still look live but tmux is empty; reconcileStaleLiveRows()
// flips them so the candidate walk picks them up.
const LIVE_STATUSES: ReadonlyArray<string> = [
  "running",
  "starting",
  "idle",
  "waiting_for_input",
  "rate_limited",
  "usage_limited",
];

// systemd starts citadel.service with Wants/After=citadel-tmux.service, but
// "After" only orders the *start command*, not socket readiness. Empirically
// the daemon can beat tmux to readiness by a few hundred ms, in which case
// listAllTmuxSessions() returns null on the first call — and the original
// reconcile path treated that as "skip", leaving every DB row pinned in
// `running` until status-monitor caught up minutes later. Retry briefly so
// the common race resolves itself without a user-visible "0 sessions
// restored" outcome.
async function awaitTmuxSessions(
  probe: () => Set<string> | null,
  timeoutMs: number,
  pollMs = 250,
): Promise<Set<string> | null> {
  const first = probe();
  if (first !== null || timeoutMs <= 0) return first;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const next = probe();
    if (next !== null) return next;
  }
  return null;
}

// Sleep helper for the retry loops — kept here so the rest of the file
// doesn't need a top-level import for one usage.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 3-strike has-session probe. A single negative result from tmux is never
// authoritative (see feedback_reaper_retries.md); we want a tight, bounded
// loop that gives the server a couple of chances under load. Returns true
// the moment any attempt confirms the session exists; only returns false
// when all three attempts agree it's gone.
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

// Walk every DB session marked live and, if its tmux session is missing from
// the live tmux server, flip it to `terminated` so collectRestoreCandidates
// returns it. Returns the count of flipped rows for logging. Idempotent and
// cheap — a single `tmux list-sessions` plus N row updates only for the
// stale rows.
async function reconcileStaleLiveRows(
  store: SqliteStore,
  liveTmuxNames: Set<string> | null,
  hasSession: (name: string) => Promise<boolean> | boolean,
): Promise<number> {
  // null = tmux server unreachable even after the readiness wait. Don't flip
  // anything — we can't distinguish "fresh boot" from "tmux genuinely down"
  // and false-positive flips lose user trust.
  if (liveTmuxNames === null) return 0;
  let flipped = 0;
  const nowIso = new Date().toISOString();
  for (const session of store.listSessions()) {
    if (!LIVE_STATUSES.includes(session.status)) continue;
    if (!session.tmuxSessionName) continue;
    if (liveTmuxNames.has(session.tmuxSessionName)) continue;
    // The `list-sessions` snapshot can be partial under load — we've seen
    // `tmux list-sessions` fail outright in the journal multiple times today
    // (`[status-monitor] tmuxActivities failed`), which would surface here as
    // a non-null but incomplete set. A retried `has-session -t <name>` is
    // the second opinion (3 attempts, 250ms apart); skip the flip whenever
    // it confirms the pane is still alive. This is what stops the cockpit
    // from showing a Restore banner for sessions whose tmux + ttyd are
    // perfectly fine.
    if (await hasSession(session.tmuxSessionName)) continue;
    store.updateSessionStatus(session.id, {
      status: "unknown",
      statusReason: "fresh_boot_recovery",
      statusReasonAt: nowIso,
      lastStatusAt: nowIso,
    });
    flipped += 1;
  }
  return flipped;
}

export type BootRestoreEntry = {
  workspaceId: string;
  workspaceName: string;
  runtimeId: string;
  runtimeSessionId: string;
  // Filled in when the resume succeeds; null on failure.
  sessionId: string | null;
  error: string | null;
};

export type BootRestoreSummary = {
  // ISO timestamp of when boot-restore kicked off. The frontend compares
  // this against the last bootedAt it saw in localStorage to decide whether
  // to show the banner — older value, banner shown once; same value, hidden.
  bootedAt: string;
  // ISO timestamp of when the last entry finished resuming. null while still
  // in progress (entries below will trickle in as the work completes).
  finishedAt: string | null;
  // Sessions we tried to resume. Includes both successes and failures so the
  // banner can render "restored 24, 3 failed" with the failure reasons.
  entries: BootRestoreEntry[];
  // Candidates we deliberately skipped (e.g. older than RECENT_WINDOW_MS).
  // Surfaced so the user knows there's more in Settings → Restore to look at.
  skippedOlder: number;
};

// Sessions whose lastActivity is older than this are NOT auto-restored.
// Keeps boot-restore from resurrecting genuinely-old rows that have been
// "stopped" in the DB for days. 24h covers crash/install/power-loss recovery
// without being aggressive.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

let currentSummary: BootRestoreSummary | null = null;

export function getBootRestoreSummary(): BootRestoreSummary | null {
  return currentSummary;
}

// Reset hook for tests — production never calls this.
export function resetBootRestoreSummaryForTests() {
  currentSummary = null;
}

export type BootRestoreDeps = {
  store: SqliteStore;
  operations: OperationService;
  config: CitadelConfig;
  emit: (type: string, payload: unknown) => void;
  // Override the tmux-session probe used by the fresh-boot reconciler. Tests
  // pass a stub (e.g. `() => null`) to suppress the reconciliation, since
  // they craft DB rows whose tmux pane intentionally does not exist. Default
  // production behaviour talks to the real `listAllTmuxSessions`.
  listTmuxSessions?: () => Set<string> | null;
  // Direct `tmux has-session -t <name>` probe used as the second opinion
  // before flipping a row to "unknown". Tests can stub this to assert the
  // safeguard fires; production hits the real tmux server. When undefined
  // and the row's name isn't in `listTmuxSessions`, the row IS flipped —
  // matches the pre-fix behaviour so tests that don't care still pass.
  hasTmuxSession?: (name: string) => boolean;
  // How long to keep retrying the tmux probe before giving up. Production
  // default covers the systemd startup race (citadel.service can outrun
  // citadel-tmux.service's socket readiness by a few hundred ms). Tests pass
  // 0 to short-circuit since their stubs are deterministic.
  tmuxReadinessTimeoutMs?: number;
  // Optional diagnostics sink — same structural shape as the global
  // DiagnosticsLogger. boot-restore emits one event per flip decision so the
  // bundle records exactly which rows were reclassified at boot.
  diagnostics?: { log(category: string, event: string, data?: Record<string, unknown>): void };
};

export async function runBootRestore(deps: BootRestoreDeps): Promise<BootRestoreSummary> {
  const bootedAt = new Date().toISOString();
  // Fresh-boot reconciliation: after a power-off, the tmux server is empty
  // but the DB still shows pre-crash sessions as live. Without this, those
  // rows pass collectRestoreCandidates' isLive() filter and get skipped —
  // exactly the failure mode where the user expects everything to come back
  // but nothing does. Flip them to `terminated` first; then they appear as
  // candidates below and get resumed via `claude --resume <uuid>`.
  const probe = deps.listTmuxSessions ?? listAllTmuxSessions;
  const tmuxReadinessTimeoutMs = deps.tmuxReadinessTimeoutMs ?? 5000;
  const liveTmuxNames = await awaitTmuxSessions(probe, tmuxReadinessTimeoutMs);
  if (liveTmuxNames === null && tmuxReadinessTimeoutMs > 0) {
    console.warn(
      `[boot-restore] tmux unreachable after ${tmuxReadinessTimeoutMs}ms — skipping fresh-boot reconciliation; live DB rows will only flip once status-monitor's first probe succeeds`,
    );
  }
  // Real `tmux has-session` probe wrapped in a 3-attempt retry. A single
  // failed probe is never authoritative (see feedback_reaper_retries.md).
  // Tests override via deps.hasTmuxSession and bypass the retry — their
  // stubs are deterministic.
  const hasSessionBase = deps.hasTmuxSession ?? tmuxSessionExists;
  const hasSession = deps.hasTmuxSession
    ? hasSessionBase
    : (name: string) => hasSessionWithRetries(hasSessionBase, name, { attempts: 3, delayMs: 250 });
  const flippedStale = await reconcileStaleLiveRows(deps.store, liveTmuxNames, hasSession);
  if (flippedStale > 0) {
    console.log(`[boot-restore] reconciled ${flippedStale} stale 'live' rows (fresh-boot)`);
  }
  deps.diagnostics?.log("restore", "reconcile.done", {
    tmuxReachable: liveTmuxNames !== null,
    liveTmuxCount: liveTmuxNames?.size ?? null,
    flippedStaleRows: flippedStale,
  });
  const allCandidates = collectRestoreCandidates(deps.store);
  const cutoffMs = Date.now() - RECENT_WINDOW_MS;
  const recent: RestoreCandidate[] = [];
  let skippedOlder = 0;
  for (const candidate of allCandidates) {
    const activityMs = Date.parse(candidate.lastActivityAt);
    if (Number.isFinite(activityMs) && activityMs >= cutoffMs) {
      recent.push(candidate);
    } else {
      skippedOlder += 1;
    }
  }

  const summary: BootRestoreSummary = {
    bootedAt,
    finishedAt: null,
    entries: recent.map((candidate) => ({
      workspaceId: candidate.workspaceId,
      workspaceName: candidate.workspaceName,
      runtimeId: candidate.runtimeId,
      runtimeSessionId: candidate.runtimeSessionId,
      sessionId: null,
      error: null,
    })),
    skippedOlder,
  };
  currentSummary = summary;

  deps.diagnostics?.log("restore", "candidates.collected", {
    total: allCandidates.length,
    recent: recent.length,
    skippedOlder,
    recentWindowMs: RECENT_WINDOW_MS,
  });
  if (recent.length === 0) {
    summary.finishedAt = new Date().toISOString();
    return summary;
  }

  // Sequential — parallel spawning of 20+ claude processes would thrash the
  // system. The cockpit polls /api/state every 5s, so the banner updates as
  // entries flip from "in progress" to "done".
  for (let i = 0; i < recent.length; i++) {
    const candidate = recent[i];
    if (!candidate) continue;
    const entry = summary.entries[i];
    if (!entry) continue;
    try {
      const runtime = deps.config.runtimes.find((r) => r.id === candidate.runtimeId);
      if (!runtime) {
        entry.error = `runtime_not_found:${candidate.runtimeId}`;
        continue;
      }
      if (!runtime.resumeArg) {
        entry.error = `runtime_does_not_support_resume:${candidate.runtimeId}`;
        continue;
      }
      // Re-check liveness right before spawning. Between collectCandidates
      // and now, another caller (the manual Restore button, a different
      // boot-restore racing with us) could have brought this UUID back.
      const sessions = deps.store.listSessions(candidate.workspaceId);
      const alreadyLive = sessions.find(
        (s) =>
          s.runtimeSessionId === candidate.runtimeSessionId &&
          (s.status === "running" ||
            s.status === "starting" ||
            s.status === "idle" ||
            s.status === "waiting_for_input" ||
            s.status === "rate_limited" ||
            s.status === "usage_limited"),
      );
      if (alreadyLive) {
        entry.sessionId = alreadyLive.id;
        continue;
      }
      const session = await deps.operations.createAgentSession(
        {
          workspaceId: candidate.workspaceId,
          runtimeId: candidate.runtimeId,
          displayName: runtime.displayName,
          resumeRuntimeSessionId: candidate.runtimeSessionId,
          // Inherit the source row's tab slot so the cockpit places the
          // restored conversation back where it lived before.
          tabId: candidate.sourceTabId,
        },
        {
          command: runtime.command,
          args: runtime.args,
          displayName: runtime.displayName,
          promptArg: runtime.promptArg ?? null,
          sessionIdArg: runtime.sessionIdArg ?? null,
          resumeArg: runtime.resumeArg ?? null,
        },
      );
      entry.sessionId = session.id;
      deps.emit("agent.updated", { workspaceId: session.workspaceId, sessionId: session.id });
      // Drop the source row whose conversation we just resumed. It points at
      // a dead pane; leaving it in the DB surfaces as a duplicate tab in the
      // cockpit (same tabId, older createdAt) and — worse — the cockpit's
      // terminal-attach handler ensureTmuxSession-creates an empty pane under
      // the dead name, giving the user two tabs per conversation: one with
      // the resumed agent and one with a bare bash shell.
      try {
        deps.operations.stopAgentSession({ sessionId: candidate.sourceSessionId });
        deps.emit("agent.updated", { workspaceId: candidate.workspaceId, sessionId: candidate.sourceSessionId });
      } catch {
        /* best-effort */
      }
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
