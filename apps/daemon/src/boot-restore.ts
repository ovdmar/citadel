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
import { type RestoreCandidate, collectRestoreCandidates } from "./restore-routes.js";

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
};

export async function runBootRestore(deps: BootRestoreDeps): Promise<BootRestoreSummary> {
  const bootedAt = new Date().toISOString();
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
            s.status === "rate_limited"),
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
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
  }

  summary.finishedAt = new Date().toISOString();
  return summary;
}
