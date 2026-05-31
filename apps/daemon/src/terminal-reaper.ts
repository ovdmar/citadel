import { execFileSync } from "node:child_process";
import { sweepPtyLogs as defaultSweepPtyLogs, sweepLegacyAgentSentinels, tmuxPrefix } from "@citadel/terminal";

// citadel-tmux.service SEGV'd at 29.8 GB on 2026-05-26 after accumulating
// per-client tmux server allocations. Each browser terminal connection
// attaches a tmux client; when the owning viewer process is killed abruptly,
// the tmux client struct inside the server can be left behind ("orphan") and
// never reclaimed.
// On a long-lived host with many sessions, those orphans compound to
// gigabytes. This reaper periodically detaches clients whose owning
// process is gone — safe by construction since detach only removes the
// viewer, never the underlying session or the agent process inside it.
//
// Two timers:
// - reap loop (default 5min): list-clients → if owner pid is dead → detach
// - rotate loop (default 6h): unlink files in $TMPDIR/citadel-pty older
//   than ptyLogMaxAgeMs (default 7 days)
//
// Both setInterval handles are .unref()'d so they don't keep the process
// alive on shutdown. The injected `listClients` / `detachClient` /
// `sweepPtyLogs` defaults call the real tmux + filesystem; tests pass
// their own to assert behaviour without touching the host.

export type StartTerminalReaperOptions = {
  reapIntervalMs?: number;
  rotateIntervalMs?: number;
  ptyLogMaxAgeMs?: number;
  listSocketNames?: () => Iterable<string | null>;
  /** Stub for `tmux list-clients`. Default invokes tmux via the citadel socket. */
  listClients?: (socketName?: string | null) => string;
  /** Stub for `tmux detach-client -t <tty>`. Default invokes tmux. */
  detachClient?: (tty: string, socketName?: string | null) => void;
  /** Stub for the pipe-pane log rotation. Default sweeps $TMPDIR/citadel-pty. */
  sweepPtyLogs?: (maxAgeMs: number) => { scanned: number; removed: number };
};

const DEFAULT_REAP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ROTATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_PTY_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function startTerminalReaper(options: StartTerminalReaperOptions = {}): { stop: () => void } {
  if (process.env.CITADEL_DISABLE_TERMINAL_REAPER === "1") return { stop() {} };
  // One-time sweep of /tmp/citadel-agent-*.{live,exit} files left behind by
  // the pre-shell-first wrapper. Age-filter + marker file gate against
  // concurrent old daemons during install rollover; safeguard caps wipe size.
  // Best-effort — failures (read-only /tmp, etc.) are silently ignored.
  try {
    sweepLegacyAgentSentinels();
  } catch {
    /* non-fatal */
  }
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const rotateIntervalMs = options.rotateIntervalMs ?? DEFAULT_ROTATE_INTERVAL_MS;
  const ptyLogMaxAgeMs = options.ptyLogMaxAgeMs ?? DEFAULT_PTY_LOG_MAX_AGE_MS;
  const listSocketNames = options.listSocketNames ?? (() => [null]);
  const listClients = options.listClients ?? defaultListClients;
  const detachClient = options.detachClient ?? defaultDetachClient;
  const sweep = options.sweepPtyLogs ?? defaultSweepPtyLogs;

  const reaperTimer = setInterval(() => {
    try {
      reapOrphanedClients(listSocketNames, listClients, detachClient);
    } catch {
      /* non-fatal — never let a stray exception crash the daemon */
    }
  }, reapIntervalMs);
  reaperTimer.unref();
  const rotateTimer = setInterval(() => {
    try {
      sweep(ptyLogMaxAgeMs);
    } catch {
      /* non-fatal */
    }
  }, rotateIntervalMs);
  rotateTimer.unref();

  return {
    stop() {
      clearInterval(reaperTimer);
      clearInterval(rotateTimer);
    },
  };
}

function reapOrphanedClients(
  listSocketNames: () => Iterable<string | null>,
  listClients: (socketName?: string | null) => string,
  detachClient: (tty: string, socketName?: string | null) => void,
): void {
  for (const socketName of listSocketNames()) {
    let raw: string;
    try {
      raw = listClients(socketName);
    } catch {
      continue; // tmux not running on this socket, no clients to reap
    }
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const space = trimmed.indexOf(" ");
      if (space < 0) continue;
      const tty = trimmed.slice(0, space).trim();
      const pidStr = trimmed.slice(space + 1).trim();
      if (!tty || !pidStr) continue;
      const pid = Number.parseInt(pidStr, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (isProcessAlive(pid)) continue;
      try {
        detachClient(tty, socketName);
      } catch {
        // ignore — client may have raced us and gone away on its own
      }
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but isn't ours — treat as alive (we're
    // not allowed to touch it, so don't detach its tmux client either).
    if (code === "EPERM") return true;
    return false;
  }
}

function defaultListClients(socketName?: string | null): string {
  return execFileSync("tmux", [...tmuxPrefix(socketName), "list-clients", "-F", "#{client_tty} #{client_pid}"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function defaultDetachClient(tty: string, socketName?: string | null): void {
  execFileSync("tmux", [...tmuxPrefix(socketName), "detach-client", "-t", tty], { stdio: "ignore" });
}
