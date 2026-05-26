// Wires the @citadel/operations status monitor with real daemon I/O —
// tmux queries, sentinel-file reads, store, SSE emit. Kept out of app.ts so
// that file stays under the 800-line gate.

import { execFileSync } from "node:child_process";
import fsPromises from "node:fs/promises";
import type { SqliteStore } from "@citadel/db";
import {
  type MonitorSessionState,
  type MonitorTickDeps,
  type SentinelReading,
  type StatusMonitorHandle,
  resumeRateLimitedSession,
  runRateLimitSchedulerTick,
  startStatusMonitor,
} from "@citadel/operations";
import type { RuntimeStatusAdapter, SessionAdapterState } from "@citadel/runtimes";
import { getStatusAdapter } from "@citadel/runtimes";
import {
  agentExitSentinelPath,
  agentLiveSentinelPath,
  captureTmux,
  captureTmuxVisibleScreen,
  pressEnter,
  readAgentExitCode,
  tmuxPrefix,
} from "@citadel/terminal";

// Dedupe monitor-side failures so a persistent tmux outage doesn't flood
// stderr at 2 Hz. Key is `kind:message` so distinct error messages are still
// reported (e.g., "ENOENT" vs "EACCES"). Cleared on process exit.
const reportedMonitorFailures = new Set<string>();
function logMonitorFailureOnce(kind: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const key = `${kind}:${msg}`;
  if (reportedMonitorFailures.has(key)) return;
  reportedMonitorFailures.add(key);
  // eslint-disable-next-line no-console
  console.error(`[status-monitor] ${kind} failed (subsequent identical errors suppressed): ${msg}`);
}

export function buildStatusMonitorDeps(
  store: SqliteStore,
  emit: (event: string, payload: unknown) => void,
): MonitorTickDeps {
  const adapterStates = new Map<string, SessionAdapterState>();
  const monitorStates = new Map<string, MonitorSessionState>();
  return {
    now: () => new Date().toISOString(),
    listSessions: () => store.listSessions(),
    listWorkspaceIds: () => new Set(store.listWorkspaces().map((ws) => ws.id)),
    updateSession: (id, update) => {
      store.updateSessionStatus(id, {
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.reason !== undefined ? { statusReason: update.reason } : {}),
        ...(update.lastStatusAt !== undefined ? { lastStatusAt: update.lastStatusAt } : {}),
        ...(update.lastOutputAt !== undefined ? { lastOutputAt: update.lastOutputAt } : {}),
        ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
      });
    },
    deleteSession: (id) => store.deleteSession(id),
    emit: (event, payload) => emit(event, payload),
    // Single batched tmux query per tick — `#{session_activity}` is epoch sec.
    // Errors are caught and reported once per (kind × error-message) so a
    // persistent tmux failure (binary missing, permission denied) surfaces in
    // logs without flooding stderr at 2 Hz.
    tmuxActivities: () => {
      try {
        const out = execFileSync(
          "tmux",
          [...tmuxPrefix(), "list-sessions", "-F", "#{session_name} #{session_activity}"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        const map = new Map<string, number>();
        for (const line of out.split("\n")) {
          const [name, secs] = line.trim().split(/\s+/);
          if (name && secs) {
            const n = Number(secs);
            if (Number.isFinite(n)) map.set(name, n * 1000);
          }
        }
        return map;
      } catch (err) {
        logMonitorFailureOnce("tmuxActivities", err);
        return new Map();
      }
    },
    paneCapture: (name) => {
      try {
        return captureTmux(name, 50);
      } catch (err) {
        logMonitorFailureOnce("paneCapture", err);
        return "";
      }
    },
    readSentinels: async (name): Promise<SentinelReading> => {
      const [liveStat, exitStat] = await Promise.all([
        fsPromises.stat(agentLiveSentinelPath(name)).catch(() => null),
        fsPromises.stat(agentExitSentinelPath(name)).catch(() => null),
      ]);
      // Stale-.exit guard: if both files exist and .live is newer than .exit,
      // the .exit is leftover from a prior wrapper incarnation with the same
      // tmux session name (e.g., daemon restart re-spawned the session before
      // /tmp was cleared). Treat the exit signal as absent so the live agent
      // doesn't get marked stopped.
      const liveNewerThanExit = liveStat !== null && exitStat !== null && liveStat.mtimeMs > exitStat.mtimeMs;
      const exitCode = exitStat && !liveNewerThanExit ? readAgentExitCode(name) : null;
      return {
        live: liveStat !== null,
        exitCode,
        exitedAt: exitStat && !liveNewerThanExit ? exitStat.ctime.toISOString() : null,
      };
    },
    getAdapter: (runtimeId): RuntimeStatusAdapter => getStatusAdapter(runtimeId),
    adapterStates,
    monitorStates,
    runRateLimitScheduler: async () => {
      try {
        await runRateLimitSchedulerTick({
          store,
          now: () => new Date().toISOString(),
          monitorStates,
          resumeSession: async (sessionId) =>
            resumeRateLimitedSession(
              {
                store,
                paneCapture: (name) => {
                  try {
                    return captureTmuxVisibleScreen(name, 200);
                  } catch {
                    return "";
                  }
                },
                pressEnter,
                getAdapter: getStatusAdapter,
              },
              { sessionId },
            ),
          emit,
        });
      } catch (err) {
        logMonitorFailureOnce("rateLimitScheduler", err);
      }
    },
  };
}

export function startDaemonStatusMonitor(
  store: SqliteStore,
  emit: (event: string, payload: unknown) => void,
): StatusMonitorHandle | null {
  if (process.env.CITADEL_DISABLE_STATUS_MONITOR === "1") return null;
  const deps = buildStatusMonitorDeps(store, emit);
  return startStatusMonitor(deps, 2000);
}
