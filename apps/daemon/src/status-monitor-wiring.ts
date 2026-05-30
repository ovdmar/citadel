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
import { discoverCodexSessionIdFromProcess, getStatusAdapter } from "@citadel/runtimes";
import { captureTmux, panePidProcess, tmuxPrefix, tmuxSessionExists } from "@citadel/terminal";

// Dedupe monitor-side failures so a persistent tmux outage doesn't flood
// stderr at 2 Hz. Key is `kind:message` so distinct error messages are still
// reported (e.g., "ENOENT" vs "EACCES"). Cleared on process exit.
const reportedMonitorFailures = new Set<string>();
const DEFAULT_STATUS_MONITOR_INTERVAL_MS = 5000;

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
  diagnostics?: MonitorTickDeps["diagnostics"],
): MonitorTickDeps {
  const adapterStates = new Map<string, SessionAdapterState>();
  const monitorStates = new Map<string, MonitorSessionState>();
  const runtimeSessionBackfillAttempts = new Map<string, number>();
  // Build runtimeId → command map once at deps construction. Re-reading
  // config on every tick would be wasteful; runtimes are static for the
  // daemon's lifetime (a config change triggers daemon restart).
  const runtimeBinaryByRuntimeId = new Map<string, string>();
  for (const rt of config.runtimes ?? []) {
    if (rt.id && rt.command) runtimeBinaryByRuntimeId.set(rt.id, rt.command);
  }
  // Per-session capture cache keyed by tmux session_activity. Adapter
  // ObservationContext requires `paneCapture: string`, so we can't defer
  // it cheaply at the adapter boundary — but we can avoid forking `tmux
  // capture-pane` for sessions whose activity timestamp didn't advance
  // since the last call. This is critical because the daemon also proxies
  // terminal WebSockets; sync capture storms in this process cause terminal
  // input lag and reconnects.
  const captureCache = new Map<string, { activityMs: number; content: string }>();
  // Shared snapshot of session_activity from the most recent tick. Updated
  // by `tmuxActivities()` (which the status monitor calls first each tick),
  // read by `paneCapture()` to know whether its cache is fresh.
  let lastActivitiesSnapshot: Map<string, number> = new Map();
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
    // Authoritative single-session existence probe. The status-monitor uses
    // it to second-opinion the batched `panes()` snapshot before flipping a
    // session to `tmux_missing`. tmuxSessionExists already returns false on
    // any IO error, so a transient tmux hiccup that takes down the batched
    // probe AND this one will still flip — but the common-case "list-panes
    // failed under load while has-session succeeds" is the one we're trying
    // to stop from wiping every session every couple minutes.
    hasTmuxSession: (name) => {
      try {
        return tmuxSessionExists(name);
      } catch (err) {
        logMonitorFailureOnce("hasTmuxSession", err);
        return false;
      }
    },
    ...(diagnostics ? { diagnostics } : {}),
    runtimeBinaryFor: (runtimeId) => runtimeBinaryByRuntimeId.get(runtimeId) ?? null,
    recoverRuntimeSessionId: (session, pane) => {
      if (session.runtimeId !== "codex") return null;
      if (!pane || pane.command !== "codex") return null;
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
      const lastAttemptMs = runtimeSessionBackfillAttempts.get(session.id) ?? 0;
      const nowMs = Date.now();
      if (nowMs - lastAttemptMs < 30_000) return null;
      runtimeSessionBackfillAttempts.set(session.id, nowMs);
      return discoverCodexSessionIdFromProcess({
        rootPid: pane.pid,
        ...(workspace ? { workspacePath: workspace.path, sessionStartedAt: session.createdAt } : {}),
      });
    },
    setRuntimeSessionId: (sessionId, runtimeSessionId) => {
      store.setSessionRuntimeSessionId(sessionId, runtimeSessionId);
      runtimeSessionBackfillAttempts.delete(sessionId);
    },
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
        lastActivitiesSnapshot = map;
        return map;
      } catch (err) {
        logMonitorFailureOnce("tmuxActivities", err);
        lastActivitiesSnapshot = new Map();
        return lastActivitiesSnapshot;
      }
    },
    // Batched pane snapshot — one fork per tick instead of N per-session
    // `tmux display-message` calls. Returns "" for `command` when tmux
    // can't determine it (shouldn't happen, defensive). Sessions absent
    // from the map are treated by the monitor as "tmux session missing"
    // (same semantic as panePidProcess returning null).
    panes: () => {
      try {
        const out = execFileSync(
          "tmux",
          [...tmuxPrefix(), "list-panes", "-a", "-F", "#{session_name}\t#{pane_current_command}\t#{pane_pid}"],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        const map = new Map<string, { command: string; pid: number }>();
        for (const line of out.split("\n")) {
          if (!line) continue;
          const [name, command, pidStr] = line.split("\t");
          if (!name || !command || !pidStr) continue;
          const pid = Number.parseInt(pidStr, 10);
          if (!Number.isFinite(pid) || pid <= 0) continue;
          // First pane in the session wins. Multi-pane sessions aren't
          // something citadel creates, but if a user splits one, we
          // arbitrarily pick the first row tmux returns.
          if (!map.has(name)) map.set(name, { command, pid });
        }
        return map;
      } catch (err) {
        logMonitorFailureOnce("panes", err);
        return new Map();
      }
    },
    paneCapture: (name) => {
      // Cache check: if tmux says the session's activity timestamp hasn't
      // advanced since we last captured, the pane content is byte-for-byte
      // identical and another `tmux capture-pane` fork would just burn CPU.
      const activityMs = lastActivitiesSnapshot.get(name) ?? 0;
      const cached = captureCache.get(name);
      if (cached && cached.activityMs === activityMs) return cached.content;
      try {
        const content = captureTmux(name, 50);
        captureCache.set(name, { activityMs, content });
        return content;
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
  diagnostics?: MonitorTickDeps["diagnostics"],
): StatusMonitorHandle | null {
  if (process.env.CITADEL_DISABLE_STATUS_MONITOR === "1") return null;
  const deps = buildStatusMonitorDeps(store, emit, config, recentUserAction, diagnostics);
  const intervalMs =
    Number.parseInt(process.env.CITADEL_STATUS_MONITOR_INTERVAL_MS ?? "", 10) || DEFAULT_STATUS_MONITOR_INTERVAL_MS;
  return startStatusMonitor(deps, intervalMs);
}
