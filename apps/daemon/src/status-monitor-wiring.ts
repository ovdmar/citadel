// Wires the @citadel/operations status monitor with real daemon I/O —
// tmux queries, shell-first pane-foreground reads, store, SSE emit. Kept
// out of app.ts so that file stays under the 800-line gate.

import { execFileSync } from "node:child_process";
import type { CitadelConfig } from "@citadel/config";
import type { SqliteStore } from "@citadel/db";
import {
  type MonitorSessionState,
  type MonitorTickDeps,
  type StatusMonitorHandle,
  startStatusMonitor,
} from "@citadel/operations";
import type { RuntimeStatusAdapter, SessionAdapterState } from "@citadel/runtimes";
import { getStatusAdapter } from "@citadel/runtimes";
import { captureTmux, panePidProcess, tmuxPrefix } from "@citadel/terminal";

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
  config: CitadelConfig,
  recentUserAction: Map<string, number>,
): MonitorTickDeps {
  const adapterStates = new Map<string, SessionAdapterState>();
  const monitorStates = new Map<string, MonitorSessionState>();
  // Build runtimeId → command map once at deps construction. Re-reading
  // config on every tick would be wasteful; runtimes are static for the
  // daemon's lifetime (a config change triggers daemon restart).
  const runtimeBinaryByRuntimeId = new Map<string, string>();
  for (const rt of config.runtimes ?? []) {
    if (rt.id && rt.command) runtimeBinaryByRuntimeId.set(rt.id, rt.command);
  }
  return {
    now: () => new Date().toISOString(),
    listSessions: () => store.listSessions(),
    listWorkspaceIds: () => new Set(store.listWorkspaces().map((ws) => ws.id)),
    updateSession: (id, update) => {
      store.updateSessionStatus(id, {
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.reason !== undefined ? { statusReason: update.reason } : {}),
        ...(update.reasonAt !== undefined ? { statusReasonAt: update.reasonAt } : {}),
        ...(update.lastStatusAt !== undefined ? { lastStatusAt: update.lastStatusAt } : {}),
        ...(update.lastOutputAt !== undefined ? { lastOutputAt: update.lastOutputAt } : {}),
        ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
      });
    },
    deleteSession: (id) => store.deleteSession(id),
    emit: (event, payload) => emit(event, payload),
    panePidProcess: (name) => {
      try {
        return panePidProcess(name);
      } catch (err) {
        logMonitorFailureOnce("panePidProcess", err);
        return null;
      }
    },
    runtimeBinaryFor: (runtimeId) => runtimeBinaryByRuntimeId.get(runtimeId) ?? null,
    recentUserAction,
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
    getAdapter: (runtimeId): RuntimeStatusAdapter => getStatusAdapter(runtimeId),
    adapterStates,
    monitorStates,
  };
}

export function startDaemonStatusMonitor(
  store: SqliteStore,
  emit: (event: string, payload: unknown) => void,
  config: CitadelConfig,
  recentUserAction: Map<string, number>,
): StatusMonitorHandle | null {
  if (process.env.CITADEL_DISABLE_STATUS_MONITOR === "1") return null;
  const deps = buildStatusMonitorDeps(store, emit, config, recentUserAction);
  return startStatusMonitor(deps, 2000);
}
