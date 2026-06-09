// Wires the @citadel/operations status monitor with real daemon I/O —
// tmux queries, shell-first pane-foreground reads, store, SSE emit. Kept
// out of app.ts so that file stays under the 800-line gate.

import { execFileSync } from "node:child_process";
import type { CitadelConfig } from "@citadel/config";
import type { AgentSession, TerminalSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import {
  type MonitorSessionState,
  type MonitorTickDeps,
  type PaneCaptureOptions,
  type StatusMonitorHandle,
  startStatusMonitor,
} from "@citadel/operations";
import type { RuntimeStatusAdapter, SessionAdapterState } from "@citadel/runtimes";
import { codexHomeForWorkspace, discoverCodexSessionIdFromProcess, getStatusAdapter } from "@citadel/runtimes";
import { captureTmuxAsync, panePidProcess, tmuxPrefix, tmuxSessionExists } from "@citadel/terminal";

// Dedupe monitor-side failures so a persistent tmux outage doesn't flood
// stderr at 2 Hz. Key is `kind:message` so distinct error messages are still
// reported (e.g., "ENOENT" vs "EACCES"). Cleared on process exit.
const reportedMonitorFailures = new Set<string>();
export const DEFAULT_STATUS_MONITOR_INTERVAL_MS = 2000;
const DEFAULT_PANE_CAPTURE_CACHE_MAX_AGE_MS = 10_000;

function logMonitorFailureOnce(kind: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const key = `${kind}:${msg}`;
  if (reportedMonitorFailures.has(key)) return;
  reportedMonitorFailures.add(key);
  // eslint-disable-next-line no-console
  console.error(`[status-monitor] ${kind} failed (subsequent identical errors suppressed): ${msg}`);
}

export type PaneCaptureCacheEntry = { activityMs: number; capturedAtMs: number; content: string };

export function shouldReusePaneCaptureCache(
  cached: PaneCaptureCacheEntry | undefined,
  activityMs: number,
  nowMs: number,
  options: PaneCaptureOptions = {},
): boolean {
  if (!cached || options.force === true) return false;
  if (cached.activityMs !== activityMs) return false;
  const rawMaxAgeMs = options.maxAgeMs ?? DEFAULT_PANE_CAPTURE_CACHE_MAX_AGE_MS;
  const maxAgeMs = Number.isFinite(rawMaxAgeMs) ? Math.max(0, rawMaxAgeMs) : DEFAULT_PANE_CAPTURE_CACHE_MAX_AGE_MS;
  return nowMs - cached.capturedAtMs <= maxAgeMs;
}

export interface DaemonStatusMonitorHandle extends StatusMonitorHandle {
  invalidatePaneCapture(sessionId: string): void;
}

export interface DaemonStatusMonitorDeps extends MonitorTickDeps {
  invalidatePaneCaptureForSession(sessionId: string): void;
}

export type AgentStatusTransitionObserver = (transition: {
  session: AgentSession;
  previousStatus: AgentSession["status"];
  nextStatus: AgentSession["status"];
}) => void;

export type StatusMonitorWiringOptions = {
  onAgentStatusTransition?: AgentStatusTransitionObserver;
};

export function buildStatusMonitorDeps(
  store: SqliteStore,
  emit: (event: string, payload: unknown) => void,
  config: CitadelConfig,
  recentUserAction: Map<string, number>,
  diagnostics?: MonitorTickDeps["diagnostics"],
  options: StatusMonitorWiringOptions = {},
): DaemonStatusMonitorDeps {
  const adapterStates = new Map<string, SessionAdapterState>();
  const monitorStates = new Map<string, MonitorSessionState>();
  const runtimeSessionBackfillAttempts = new Map<string, number>();
  // Build runtimeId → command map once at deps construction. Re-reading
  // config on every tick would be wasteful; agent runtimes are static for the
  // daemon's lifetime (a config change triggers daemon restart).
  const runtimeBinaryByRuntimeId = new Map<string, string>();
  for (const rt of config.agentRuntimes ?? []) {
    if (rt.id && rt.command) runtimeBinaryByRuntimeId.set(rt.id, rt.command);
  }
  // Per-session capture cache keyed by tmux session_activity. Capture uses
  // async subprocesses so terminal WebSocket input/output can keep flowing
  // while status detection waits on tmux; the cache avoids spawning another
  // `tmux capture-pane` when tmux says the pane content has not advanced and
  // the cached capture is still fresh enough for runtime status detection.
  const captureCache = new Map<string, PaneCaptureCacheEntry>();
  const sessionSocketByName = new Map<string, string | null>();
  const sessionNameById = new Map<string, string>();
  // Shared snapshot of session_activity from the most recent tick. Updated
  // by `tmuxActivities()` (which the status monitor calls first each tick),
  // read by `paneCapture()` to know whether its cache is fresh.
  let lastActivitiesSnapshot: Map<string, number> = new Map();
  const sessionSocket = (name: string) => sessionSocketByName.get(name) ?? null;
  const activeSockets = () => new Set(sessionSocketByName.values());
  return {
    now: () => new Date().toISOString(),
    listSessions: () => {
      const sessions = store.listWorkspaceSessions();
      sessionSocketByName.clear();
      sessionNameById.clear();
      for (const session of sessions) {
        if (session.tmuxSessionName) {
          sessionSocketByName.set(session.tmuxSessionName, session.tmuxSocketName ?? null);
          sessionNameById.set(session.id, session.tmuxSessionName);
        }
      }
      return sessions.filter((session) => session.kind === "agent");
    },
    listTerminalSessions: () =>
      store
        .listWorkspaceSessions()
        .filter((session): session is TerminalSession => session.kind === "terminal" && !session.closedAt),
    listWorkspaceIds: () => new Set(store.listWorkspaces().map((ws) => ws.id)),
    updateSession: (id, update) => {
      const previous =
        update.status !== undefined
          ? store.listWorkspaceSessions().find((candidate) => candidate.id === id)
          : undefined;
      store.updateSessionStatus(id, {
        ...(update.status !== undefined ? { status: update.status } : {}),
        ...(update.reason !== undefined ? { statusReason: update.reason } : {}),
        ...(update.reasonAt !== undefined ? { statusReasonAt: update.reasonAt } : {}),
        ...(update.lastStatusAt !== undefined ? { lastStatusAt: update.lastStatusAt } : {}),
        ...(update.lastOutputAt !== undefined ? { lastOutputAt: update.lastOutputAt } : {}),
        ...(update.endedAt !== undefined ? { endedAt: update.endedAt } : {}),
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
      });
      if (
        previous?.kind === "agent" &&
        update.status !== undefined &&
        update.status !== previous.status &&
        options.onAgentStatusTransition
      ) {
        options.onAgentStatusTransition({
          session: previous,
          previousStatus: previous.status,
          nextStatus: update.status,
        });
      }
    },
    deleteSession: (id) => store.deleteSession(id),
    emit: (event, payload) => emit(event, payload),
    panePidProcess: (name) => {
      try {
        return panePidProcess(name, sessionSocket(name));
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
        return tmuxSessionExists(name, sessionSocket(name));
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
        codexHome: codexHomeForWorkspace(session.workspaceId),
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
        const map = new Map<string, number>();
        for (const socketName of activeSockets()) {
          try {
            const out = execFileSync(
              "tmux",
              [...tmuxPrefix(socketName), "list-sessions", "-F", "#{session_name} #{session_activity}"],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
            for (const line of out.split("\n")) {
              const [name, secs] = line.trim().split(/\s+/);
              if (name && secs) {
                const n = Number(secs);
                if (Number.isFinite(n)) map.set(name, n * 1000);
              }
            }
          } catch (err) {
            logMonitorFailureOnce(`tmuxActivities:${socketName ?? "default"}`, err);
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
        const map = new Map<string, { command: string; pid: number }>();
        for (const socketName of activeSockets()) {
          try {
            const out = execFileSync(
              "tmux",
              [
                ...tmuxPrefix(socketName),
                "list-panes",
                "-a",
                "-F",
                "#{session_name}\t#{pane_current_command}\t#{pane_pid}",
              ],
              {
                encoding: "utf8",
                stdio: ["ignore", "pipe", "ignore"],
              },
            );
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
          } catch (err) {
            logMonitorFailureOnce(`panes:${socketName ?? "default"}`, err);
          }
        }
        return map;
      } catch (err) {
        logMonitorFailureOnce("panes", err);
        return new Map();
      }
    },
    paneCapture: async (name, options) => {
      // Cache check: if tmux says the session's activity timestamp hasn't
      // advanced and our capture is still fresh enough, another
      // `tmux capture-pane` fork would just burn CPU. The max-age guard is
      // important for Codex: its TUI can visibly repaint from idle to
      // `esc to interrupt` without tmux advancing `#{session_activity}`.
      const activityMs = lastActivitiesSnapshot.get(name) ?? 0;
      const cached = captureCache.get(name);
      if (cached && shouldReusePaneCaptureCache(cached, activityMs, Date.now(), options)) return cached.content;
      try {
        const content = await captureTmuxAsync(name, 50, sessionSocket(name));
        captureCache.set(name, { activityMs, capturedAtMs: Date.now(), content });
        return content;
      } catch (err) {
        logMonitorFailureOnce("paneCapture", err);
        return "";
      }
    },
    invalidatePaneCaptureForSession: (sessionId: string) => {
      const name =
        sessionNameById.get(sessionId) ??
        store.listWorkspaceSessions().find((candidate) => candidate.id === sessionId)?.tmuxSessionName ??
        null;
      if (name) captureCache.delete(name);
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
  options: StatusMonitorWiringOptions = {},
): DaemonStatusMonitorHandle | null {
  if (process.env.CITADEL_DISABLE_STATUS_MONITOR === "1") return null;
  const deps = buildStatusMonitorDeps(store, emit, config, recentUserAction, diagnostics, options);
  const intervalMs =
    Number.parseInt(process.env.CITADEL_STATUS_MONITOR_INTERVAL_MS ?? "", 10) || DEFAULT_STATUS_MONITOR_INTERVAL_MS;
  return {
    ...startStatusMonitor(deps, intervalMs),
    invalidatePaneCapture: deps.invalidatePaneCaptureForSession,
  };
}
