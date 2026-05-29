// Settings → Debug. One-button "Download diagnostics bundle" + a small
// tail of the in-memory ring so users (or me, looking over their shoulder)
// can see whether anything spicy happened recently without leaving the
// cockpit. Pulls /api/diagnostics/snapshot for the inline preview.
//
// Keep the surface intentionally minimal — this panel is meant for one
// thing: collecting evidence after "all my sessions died" so someone with
// context can read the JSONL trail. Styles piggyback on the existing
// `restore-panel` block so we don't add a new CSS namespace.

import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw } from "lucide-react";

type DiagnosticEvent = {
  ts: string;
  category: string;
  event: string;
  data?: Record<string, unknown>;
};

type DiagnosticsSnapshot = {
  capturedAt: string;
  daemon: {
    pid: number;
    nodeVersion: string;
    uptimeSeconds: number;
    rssMb: number;
    port: number;
    dataDir: string;
    worktree: boolean;
    tmuxSocket: string | null;
  };
  ttydInventory: Array<{ key: string; port: number; pid: number; tmuxSession: string }>;
  tmuxLiveSessions: string[] | null;
  sessions: Array<{ id: string; tabId: string | null; status: string; tmuxSessionName: string | null }>;
  recentEvents: DiagnosticEvent[];
  logFile: { path: string | null; sizeBytes: number | null };
  rotatedFile: { path: string | null; sizeBytes: number | null };
};

async function fetchSnapshot(): Promise<DiagnosticsSnapshot> {
  const res = await fetch("/api/diagnostics/snapshot", { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<DiagnosticsSnapshot>;
}

function formatBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DebugPanel() {
  const query = useQuery({
    queryKey: ["diagnostics-snapshot"],
    queryFn: fetchSnapshot,
    refetchInterval: 5000,
  });
  const snapshot = query.data;

  return (
    <div className="restore-panel">
      <p className="restore-panel__lead">
        Citadel writes a structured event log to{" "}
        <code>{snapshot?.logFile.path ?? ".citadel/diagnostics.jsonl"}</code> covering tmux/ttyd lifecycle, status-monitor
        decisions, and boot-restore. Download the bundle below and share it when reporting "my sessions died" — it
        includes the JSONL trail, a state snapshot, and the last 30 minutes of <code>citadel.service</code> journal.
      </p>

      <div className="debug-panel__actions">
        <a className="debug-panel__primary" href="/api/diagnostics/bundle.tar.gz" download>
          <Download size={14} aria-hidden /> Download diagnostics bundle
        </a>
        <button type="button" className="debug-panel__secondary" onClick={() => void query.refetch()}>
          <RefreshCw size={14} aria-hidden /> Refresh
        </button>
      </div>

      {snapshot ? (
        <>
          <dl className="debug-panel__grid">
            <div>
              <dt>Daemon PID</dt>
              <dd>{snapshot.daemon.pid}</dd>
            </div>
            <div>
              <dt>Port</dt>
              <dd>{snapshot.daemon.port}</dd>
            </div>
            <div>
              <dt>Uptime</dt>
              <dd>{Math.round(snapshot.daemon.uptimeSeconds / 60)} min</dd>
            </div>
            <div>
              <dt>RSS</dt>
              <dd>{snapshot.daemon.rssMb} MB</dd>
            </div>
            <div>
              <dt>Worktree daemon</dt>
              <dd>{snapshot.daemon.worktree ? "yes" : "no"}</dd>
            </div>
            <div>
              <dt>Tmux socket</dt>
              <dd>{snapshot.daemon.tmuxSocket ?? "default"}</dd>
            </div>
            <div>
              <dt>Live ttyds</dt>
              <dd>{snapshot.ttydInventory.length}</dd>
            </div>
            <div>
              <dt>Live tmux sessions</dt>
              <dd>{snapshot.tmuxLiveSessions === null ? "unreachable" : snapshot.tmuxLiveSessions.length}</dd>
            </div>
            <div>
              <dt>Log file size</dt>
              <dd>
                {formatBytes(snapshot.logFile.sizeBytes)}
                {snapshot.rotatedFile.sizeBytes !== null
                  ? ` (+ rotated ${formatBytes(snapshot.rotatedFile.sizeBytes)})`
                  : ""}
              </dd>
            </div>
          </dl>

          <h3 className="debug-panel__heading">Recent events (last {snapshot.recentEvents.length})</h3>
          {snapshot.recentEvents.length === 0 ? (
            <p className="restore-panel__empty">
              No events yet — they'll appear here as soon as the daemon does something interesting.
            </p>
          ) : (
            <div className="debug-panel__events">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Category</th>
                    <th>Event</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.recentEvents
                    .slice(-50)
                    .reverse()
                    .map((ev, i) => (
                      <tr key={`${ev.ts}-${i}`}>
                        <td className="debug-panel__ts">{ev.ts.slice(11, 19)}</td>
                        <td className="debug-panel__cat">{ev.category}</td>
                        <td className="debug-panel__name">{ev.event}</td>
                        <td className="debug-panel__data">
                          <code>{ev.data ? JSON.stringify(ev.data) : ""}</code>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : query.isError ? (
        <p className="restore-panel__error">Could not load diagnostics snapshot: {String(query.error)}</p>
      ) : (
        <p className="restore-panel__empty">Loading snapshot…</p>
      )}
    </div>
  );
}
