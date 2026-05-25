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
  startStatusMonitor,
} from "@citadel/operations";
import type { RuntimeStatusAdapter, SessionAdapterState } from "@citadel/runtimes";
import { getStatusAdapter } from "@citadel/runtimes";
import { agentExitSentinelPath, agentLiveSentinelPath, captureTmux, readAgentExitCode } from "@citadel/terminal";

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
    tmuxActivities: () => {
      try {
        const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name} #{session_activity}"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const map = new Map<string, number>();
        for (const line of out.split("\n")) {
          const [name, secs] = line.trim().split(/\s+/);
          if (name && secs) {
            const n = Number(secs);
            if (Number.isFinite(n)) map.set(name, n * 1000);
          }
        }
        return map;
      } catch {
        return new Map();
      }
    },
    paneCapture: (name) => {
      try {
        return captureTmux(name, 50);
      } catch {
        return "";
      }
    },
    readSentinels: async (name): Promise<SentinelReading> => {
      const [liveStat, exitStat] = await Promise.all([
        fsPromises.stat(agentLiveSentinelPath(name)).catch(() => null),
        fsPromises.stat(agentExitSentinelPath(name)).catch(() => null),
      ]);
      const exitCode = exitStat ? readAgentExitCode(name) : null;
      return {
        live: liveStat !== null,
        exitCode,
        exitedAt: exitStat ? exitStat.ctime.toISOString() : null,
      };
    },
    getAdapter: (runtimeId): RuntimeStatusAdapter => getStatusAdapter(runtimeId),
    adapterStates,
    monitorStates,
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
