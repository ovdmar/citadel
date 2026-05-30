import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { tmuxPrefix } from "./index.js";
import {
  killStaleTtydInRange,
  listListeningPortsInRange,
  listeningPidForPort,
  processAlive,
  trimSlashes,
} from "./ttyd-process.js";
import { type TtydTheme, ttydThemeArgs } from "./ttyd-theme.js";
export type { TtydTheme } from "./ttyd-theme.js";
export { discoverExistingTtyds } from "./ttyd-process.js";

export type TtydEntry = {
  key: string;
  port: number;
  pid: number;
  basePath: string;
  tmuxSession: string;
  worktreePath: string | null;
  startedAt: string;
  theme: TtydTheme;
  /**
   * Cockpit tab the entry belongs to. Sessions resumed inside the same tab
   * (e.g. `claude --resume <uuid>`) reuse the source row's tabId — we use
   * that here to enforce one ttyd per tabId and to recover the right entry
   * after a daemon restart. `null` for the legacy adoption path when we
   * don't have a DB row to resolve the owning tab.
   */
  tabId: string | null;
};

/** Structural type for the optional diagnostics logger. Defined here so
 * @citadel/terminal doesn't have to import @citadel/operations (would create
 * a circular dependency). The daemon hands in a real DiagnosticsLogger
 * instance whose shape is a strict superset. */
export type TtydDiagnosticsSink = {
  log(category: string, event: string, data?: Record<string, unknown>): void;
};

export type TtydManagerConfig = {
  /** Absolute path to the ttyd binary. Defaults to TTYD_BIN env or `/home/linuxbrew/.linuxbrew/bin/ttyd`. */
  ttydBin?: string;
  /** Shell used to wrap the tmux attach command. Defaults to CITADEL_SHELL_BIN / SHELL / `/bin/bash`. */
  shellBin?: string;
  /** Inclusive lower bound for dynamic port allocation. */
  portBase?: number;
  /** Inclusive upper bound for dynamic port allocation. */
  portMax?: number;
  /** Public base-path prefix for proxied URLs. Each entry uses `${basePathPrefix}/<key>`. */
  basePathPrefix?: string;
  /** Maximum ms to wait for ttyd to start listening. */
  readyTimeoutMs?: number;
  /** Public host used in the proxied URL emitted to clients. */
  publicPath?: (key: string) => string;
  /** Optional structured-event sink. When wired, the manager records every
   * spawn/exit/adopt/release/reap so the diagnostics bundle can reconstruct
   * "where did my ttyd go". Defaults to a no-op. */
  diagnostics?: TtydDiagnosticsSink;
};

const DEFAULTS = {
  ttydBin: process.env.TTYD_BIN || "/home/linuxbrew/.linuxbrew/bin/ttyd",
  shellBin: process.env.CITADEL_SHELL_BIN || process.env.SHELL || "/bin/bash",
  // Default range is 11000-11999 (1000 ports) — empirically high enough that
  // we never bump into the cap with realistic agent-session counts, and far
  // from common low-port ranges (services, dev servers, etc.). Multi-daemon
  // co-existence carves this out via apps/daemon/src/ttyd-slot.ts which
  // assigns each daemon a disjoint 1000-port slice (slot k → 11000+k*1000).
  portBase: Number.parseInt(process.env.CITADEL_TTYD_PORT_BASE ?? "", 10) || 11000,
  portMax: Number.parseInt(process.env.CITADEL_TTYD_PORT_MAX ?? "", 10) || 11999,
  basePathPrefix: "/terminals",
  // 10s readiness budget: under spawn storms (multiple ttyds respawning at
  // once after `make deploy`) ttyd can take several seconds to bind, and a
  // tight 4s window produced spurious "Terminal unavailable" errors. The
  // happy path resolves in <100ms; the extra ceiling only matters when the
  // kernel is busy scheduling the new process.
  readyTimeoutMs: 10000,
};

const TTYD_PING_INTERVAL_SECONDS = 45;

export class TtydUnavailableError extends Error {
  readonly code: "ttyd_missing" | "no_free_port" | "ttyd_start_timeout" | "tmux_session_missing" | "spawn_failed";
  constructor(code: TtydUnavailableError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TtydUnavailableError";
  }
}

// `child` is null when the entry was *adopted* at boot from a ttyd left
// behind by a previous daemon incarnation — we have the PID but no live
// ChildProcess handle. Liveness/kill go through the helpers below so the
// two flavours behave the same to callers.
type ManagedEntry = TtydEntry & { child: ChildProcess | null };

/** Lock identity for single-flight + per-tab dedup. Prefer tabId because
 * that's the user-visible "one terminal per tab" invariant; fall back to the
 * entry key (sessionId) when no tabId was supplied (legacy path / tests). */
function lockIdFor(args: { key: string; tabId?: string | null }): string {
  return args.tabId && args.tabId.length > 0 ? `tab:${args.tabId}` : `key:${args.key}`;
}

function isEntryAlive(entry: ManagedEntry): boolean {
  if (entry.child) return entry.child.exitCode === null && !entry.child.killed;
  if (!entry.pid || entry.pid <= 0) return false;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalEntry(entry: ManagedEntry, signal: NodeJS.Signals): void {
  if (entry.child) {
    try {
      entry.child.kill(signal);
    } catch {
      // ignore
    }
    return;
  }
  if (!entry.pid || entry.pid <= 0) return;
  try {
    process.kill(entry.pid, signal);
  } catch {
    // ignore
  }
}

export type TtydManager = {
  ensure(input: {
    key: string;
    tmuxSession: string;
    /** Cockpit tab the entry belongs to. When two ensure() calls land for
     * the same tabId but different keys (e.g. a resumed session's row
     * replaces the source row), the previous entry for that tab is
     * SIGTERMed before the new ttyd is spawned — one ttyd per tab. */
    tabId?: string | null;
    worktreePath?: string | null;
    /** Cockpit-resolved theme used to spawn ttyd with the matching xterm palette. Defaults to "dark". */
    theme?: TtydTheme;
    /** When true, kill any existing ttyd for this key and spawn a fresh one. */
    force?: boolean;
    /**
     * Enable tmux mouse mode for this session. Used for runtimes (codex,
     * cursor-agent) whose TUIs grab DEC mouse tracking and consume wheel
     * events for prompt-history nav — tmux intercepts the wheel first and
     * routes it to copy-mode scrollback instead. Scoped per tmux session,
     * so Claude Code's xterm-native wheel scrollback is unaffected.
     */
    enableTmuxMouse?: boolean;
  }): Promise<TtydEntry>;
  lookup(key: string): TtydEntry | null;
  release(key: string, reason?: string): void;
  /** Release every entry whose tabId matches. Used by the workspace-remove
   * path so closing a workspace tears down its ttyds along with the tmux
   * sessions. */
  releaseTab(tabId: string, reason?: string): number;
  list(): TtydEntry[];
  cleanupStale(): { killed: number; portRange: [number, number] };
  /**
   * Adopt ttyd processes left behind by a previous daemon incarnation.
   * Called at boot with the output of `discoverExistingTtyds()` — adopted
   * entries reuse the same `TtydEntry` shape but have no in-process
   * ChildProcess handle (liveness/kill go via PID). If multiple records
   * share a key (zombies from prior racey respawns), the oldest wins and
   * the rest get SIGTERMed. When a `resolveTabId` callback is supplied,
   * records whose key resolves to `null` (no live DB row) are SIGTERMed as
   * legacy orphans — this is what reaps ttyds left behind by code that
   * predated the ttyd-slot.ts port range (the 7xxx generation).
   */
  adopt(
    records: TtydEntry[],
    resolveTabId?: (key: string) => string | null,
  ): { adopted: number; reapedDuplicates: number; reapedUnknown: number };
  shutdown(): void;
  config: Required<Omit<TtydManagerConfig, "publicPath" | "diagnostics">> &
    Pick<TtydManagerConfig, "publicPath" | "diagnostics">;
};

export function createTtydManager(input: TtydManagerConfig = {}): TtydManager {
  const config = {
    ttydBin: input.ttydBin ?? DEFAULTS.ttydBin,
    shellBin: input.shellBin ?? DEFAULTS.shellBin,
    portBase: input.portBase ?? DEFAULTS.portBase,
    portMax: input.portMax ?? DEFAULTS.portMax,
    basePathPrefix: trimSlashes(input.basePathPrefix ?? DEFAULTS.basePathPrefix),
    readyTimeoutMs: input.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs,
    publicPath: input.publicPath,
  };
  const diag: TtydDiagnosticsSink = input.diagnostics ?? { log() {} };
  const entries = new Map<string, ManagedEntry>();
  const reservedPorts = new Set<number>();
  // tabId → key map so we can find the current ttyd for a tab without
  // scanning every entry. Single source of truth for "which key serves
  // tab X right now". Updated in lockstep with entries.
  const tabIndex = new Map<string, string>();
  // Single-flight gate. The cockpit's HTTP POST and the WebSocket upgrade
  // for the same iframe land milliseconds apart after a restart; without
  // this, both branches enter ensure() with an empty entries map and each
  // spawns its own ttyd. They share the in-flight promise here, so only
  // one spawn ever happens per tab.
  const inflight = new Map<string, Promise<TtydEntry>>();

  const publicPathFor = (key: string) =>
    config.publicPath ? config.publicPath(key) : `/${config.basePathPrefix}/${encodeURIComponent(key)}/`;

  function removeFromTabIndex(key: string): void {
    for (const [tab, mapped] of tabIndex) {
      if (mapped === key) {
        tabIndex.delete(tab);
        return;
      }
    }
  }

  function setEntry(record: ManagedEntry): void {
    entries.set(record.key, record);
    if (record.tabId) tabIndex.set(record.tabId, record.key);
  }

  function deleteEntry(key: string): ManagedEntry | undefined {
    const existing = entries.get(key);
    if (!existing) return undefined;
    entries.delete(key);
    if (existing.tabId) {
      // Clear only if this key still owns the slot (defensive — releasing
      // a stale duplicate must not pull the active entry out of the index).
      if (tabIndex.get(existing.tabId) === key) tabIndex.delete(existing.tabId);
    } else {
      removeFromTabIndex(key);
    }
    return existing;
  }

  async function ensure(args: {
    key: string;
    tmuxSession: string;
    tabId?: string | null;
    worktreePath?: string | null;
    theme?: TtydTheme;
    /** Kill the existing ttyd (if any) and spawn a fresh process. Used by the
     * cockpit's reload affordance so theme/palette changes take effect — ttyd
     * bakes the xterm palette at spawn time, so an explicit respawn is the
     * only way to repaint a live session. We don't auto-respawn on theme
     * drift to avoid reconnect storms when the user just toggles the cockpit
     * theme; respawn is opt-in via this flag. */
    force?: boolean;
    enableTmuxMouse?: boolean;
  }): Promise<TtydEntry> {
    const lockId = lockIdFor(args);
    const existingFlight = inflight.get(lockId);
    if (existingFlight) return existingFlight;
    const flight = ensureInner(args).finally(() => {
      inflight.delete(lockId);
    });
    inflight.set(lockId, flight);
    return flight;
  }

  async function ensureInner(args: {
    key: string;
    tmuxSession: string;
    tabId?: string | null;
    worktreePath?: string | null;
    theme?: TtydTheme;
    force?: boolean;
    enableTmuxMouse?: boolean;
  }): Promise<TtydEntry> {
    const desiredTheme: TtydTheme = args.theme ?? "dark";
    const tabId = args.tabId ?? null;
    let targetTmuxAlive: boolean | null = null;

    function assertTargetTmuxAlive(context: Record<string, unknown>): void {
      targetTmuxAlive ??= tmuxSessionAlive(args.tmuxSession);
      if (targetTmuxAlive) return;
      diag.log("ttyd", "ensure.tmux-missing", {
        key: args.key,
        tabId,
        tmuxSession: args.tmuxSession,
        ...context,
      });
      throw new TtydUnavailableError("tmux_session_missing", `tmux session ${args.tmuxSession} not found`);
    }

    // Tab-level dedup: if a different key already serves this tab, that's
    // a stale entry (typically the source row of a just-completed restore,
    // whose ttyd is still alive but no longer reachable from the cockpit's
    // new iframe URL). Tear it down before spawning so the invariant
    // holds: one live ttyd per tabId.
    if (tabId) {
      const incumbentKey = tabIndex.get(tabId);
      if (incumbentKey && incumbentKey !== args.key) {
        const incumbent = entries.get(incumbentKey);
        if (incumbent && isEntryAlive(incumbent)) {
          assertTargetTmuxAlive({
            phase: "tab-replace",
            incumbentKey,
            incumbentTmuxSession: incumbent.tmuxSession,
          });
          signalEntry(incumbent, "SIGTERM");
          deleteEntry(incumbentKey);
        } else if (incumbent) {
          deleteEntry(incumbentKey);
        } else {
          tabIndex.delete(tabId);
        }
      }
    }

    const existing = entries.get(args.key);
    // Trust the child-process liveness signal rather than probing the port.
    // The `child.on('exit')` handler below deletes the entry as soon as the
    // ttyd process dies, so `existing.child.exitCode === null` is sufficient
    // proof that the ttyd is alive and reachable.
    //
    // An earlier version did `await portOpen(existing.port)` as a defensive
    // double-check. portOpen has a 150ms localhost TCP connect timeout, which
    // localhost normally returns under 1ms — but under spawn-storm load
    // (e.g. `pnpm check` forking node/tsx/tsc workers) the kernel can take
    // longer to schedule the SYN. The probe returns false for a live ttyd,
    // the daemon then SIGTERMs the live ttyd and respawns it, the cockpit's
    // WebSocket drops → "Reconnecting/Reconnected" overlay storm, repeats
    // per session for every ensure() call landing during the burst.
    if (existing && isEntryAlive(existing)) {
      // If the existing ttyd is attached to the wrong tmux target (the
      // session was respawned under a new name during boot-restore), we
      // can't switch its attach in-place — respawn. Palette changes are only
      // applied on explicit force=true reload; automatic theme drift must not
      // tear down an active terminal connection.
      const tmuxMismatch = existing.tmuxSession !== args.tmuxSession;
      if (!args.force && !tmuxMismatch) {
        if (tabId && existing.tabId !== tabId) {
          const refreshed: ManagedEntry = { ...existing, tabId };
          setEntry(refreshed);
          return toEntry(refreshed);
        }
        return toEntry(existing);
      }
      assertTargetTmuxAlive({
        phase: "respawn",
        port: existing.port,
        reason: tmuxMismatch ? "tmux-mismatch" : "force",
        oldTmuxSession: existing.tmuxSession,
      });
      diag.log("ttyd", "respawn", {
        key: args.key,
        tabId,
        port: existing.port,
        reason: tmuxMismatch ? "tmux-mismatch" : "force",
        oldTmuxSession: existing.tmuxSession,
        newTmuxSession: args.tmuxSession,
        oldTheme: existing.theme,
        newTheme: desiredTheme,
      });
      signalEntry(existing, "SIGTERM");
      deleteEntry(args.key);
    }
    assertTargetTmuxAlive({ phase: "spawn" });
    if (!binaryExists(config.ttydBin)) {
      throw new TtydUnavailableError("ttyd_missing", `ttyd binary not found at ${config.ttydBin}`);
    }
    const port = await reserveFreePort(config.portBase, config.portMax, reservedPorts);
    const basePath = `/${config.basePathPrefix}/${encodeURIComponent(args.key)}`;
    const attachCommand = buildAttachCommand(args.tmuxSession, { enableMouse: args.enableTmuxMouse === true });
    const themeOptions = ttydThemeArgs(desiredTheme);
    let child: ChildProcess;
    try {
      child = spawn(
        config.ttydBin,
        [
          "-W",
          "--check-origin=false",
          "-p",
          String(port),
          "-i",
          "127.0.0.1",
          "-b",
          basePath,
          "-P",
          String(TTYD_PING_INTERVAL_SECONDS),
          ...themeOptions,
          config.shellBin,
          "-lc",
          attachCommand,
        ],
        // detached + unref: put ttyd in its own process group / session so
        // signals sent to the daemon's pgrp (Ctrl-C, etc) don't reach it,
        // and the daemon's event loop doesn't keep a handle on the child.
        // Combined with KillMode=process on citadel.service, this lets
        // ttyd survive daemon restarts — terminal sessions stay connected
        // and the boot-time discover-and-adopt path picks them back up.
        { detached: true, stdio: "ignore" },
      );
      child.unref();
    } catch (error) {
      reservedPorts.delete(port);
      throw new TtydUnavailableError("spawn_failed", error instanceof Error ? error.message : "failed to spawn ttyd");
    }
    const startedAt = new Date().toISOString();
    const record: ManagedEntry = {
      key: args.key,
      port,
      pid: child.pid ?? -1,
      basePath,
      tmuxSession: args.tmuxSession,
      worktreePath: args.worktreePath ?? null,
      startedAt,
      theme: desiredTheme,
      tabId,
      child,
    };
    setEntry(record);
    diag.log("ttyd", "spawn", {
      key: args.key,
      tabId,
      port,
      pid: record.pid,
      tmuxSession: args.tmuxSession,
      theme: desiredTheme,
    });
    child.on("exit", (code, signal) => {
      reservedPorts.delete(port);
      const current = entries.get(args.key);
      if (current && current.pid === record.pid) deleteEntry(args.key);
      diag.log("ttyd", "exit", { key: args.key, tabId, port, pid: record.pid, code, signal });
    });
    const ready = await waitForOwnedPort(port, record.pid, config.readyTimeoutMs);
    if (!ready) {
      deleteEntry(args.key);
      reservedPorts.delete(port);
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      throw new TtydUnavailableError("ttyd_start_timeout", `ttyd did not listen on port ${port} within timeout`);
    }
    reservedPorts.delete(port);
    return toEntry(record);
  }

  function lookup(key: string): TtydEntry | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (!isEntryAlive(entry)) {
      deleteEntry(key);
      return null;
    }
    return toEntry(entry);
  }

  function release(key: string, reason = "unspecified") {
    const entry = entries.get(key);
    if (!entry) return;
    diag.log("ttyd", "release", { key, tabId: entry.tabId, port: entry.port, pid: entry.pid, reason });
    signalEntry(entry, "SIGTERM");
    deleteEntry(key);
  }

  function releaseTab(tabId: string, reason = "tab-release") {
    const key = tabIndex.get(tabId);
    let released = 0;
    if (key) {
      const entry = entries.get(key);
      if (entry) {
        diag.log("ttyd", "release", { key, tabId: entry.tabId, port: entry.port, pid: entry.pid, reason });
        signalEntry(entry, "SIGTERM");
        deleteEntry(key);
        released += 1;
      } else {
        tabIndex.delete(tabId);
      }
    }
    // Defensive sweep: an earlier code path might have orphaned an entry
    // whose tabId matches but never made it into the tabIndex slot (race
    // with deleteEntry on a duplicate). Catch them here too.
    for (const [k, entry] of Array.from(entries)) {
      if (entry.tabId === tabId) {
        diag.log("ttyd", "release", { key: k, tabId: entry.tabId, port: entry.port, pid: entry.pid, reason });
        signalEntry(entry, "SIGTERM");
        deleteEntry(k);
        released += 1;
      }
    }
    return released;
  }

  function list() {
    return Array.from(entries.values())
      .filter((entry) => isEntryAlive(entry))
      .map(toEntry);
  }

  function cleanupStale() {
    const killed = killStaleTtydInRange(config.portBase, config.portMax);
    return { killed, portRange: [config.portBase, config.portMax] as [number, number] };
  }

  function adopt(
    records: TtydEntry[],
    resolveTabId?: (key: string) => string | null,
  ): { adopted: number; reapedDuplicates: number; reapedUnknown: number } {
    let adopted = 0;
    let reapedDuplicates = 0;
    let reapedUnknown = 0;
    // Sort by startedAt ascending so we keep the OLDEST ttyd per key — that
    // is the one the cockpit iframe is most likely already talking to. Any
    // newer duplicates (from prior race-condition respawns across daemon
    // restarts) get SIGTERMed to free the port + tmux client slot.
    const sorted = [...records].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    // Per-tab dedup: many of the duplicates we see on this host post-restart
    // share a tabId (same session resumed, multiple ensure() calls landed
    // before the per-tab single-flight lock existed). Keep the oldest in
    // each tab; SIGTERM the rest. Computed up-front so we can decide
    // independently of `entries.has(key)`.
    const tabWinner = new Map<string, string>();
    if (resolveTabId) {
      for (const record of sorted) {
        const tabId = resolveTabId(record.key);
        if (!tabId) continue;
        if (!tabWinner.has(tabId)) tabWinner.set(tabId, record.key);
      }
    }
    for (const record of sorted) {
      const tabId = resolveTabId ? resolveTabId(record.key) : null;
      // Unknown key (no live DB row): legacy orphan from before the current
      // port slot scheme or from a session that's been removed. SIGTERM so
      // it stops holding tmux clients + a port. This is what cleans up the
      // 7xxx-range ttyds that the per-slot cleanupStale() can't see.
      if (resolveTabId && tabId === null) {
        if (record.pid > 0) {
          try {
            process.kill(record.pid, "SIGTERM");
            reapedUnknown += 1;
          } catch {
            // already gone
          }
        }
        continue;
      }
      // Duplicate by key (older daemon respawned without releasing). Keep
      // the oldest record we already adopted; signal the rest.
      if (entries.has(record.key)) {
        if (record.pid > 0) {
          try {
            process.kill(record.pid, "SIGTERM");
            reapedDuplicates += 1;
          } catch {
            // ignore — already gone
          }
        }
        continue;
      }
      // Duplicate by tab (different keys, same tabId — typically a resumed
      // session where the source row's ttyd is still alive). Keep the
      // winner; signal everything else.
      if (tabId && tabWinner.get(tabId) !== record.key) {
        if (record.pid > 0) {
          try {
            process.kill(record.pid, "SIGTERM");
            reapedDuplicates += 1;
          } catch {
            // ignore
          }
        }
        continue;
      }
      // Adopted entries have no live ChildProcess — only the PID. They are
      // ttyds spawned by a previous daemon incarnation that survived
      // restart thanks to detached:true + KillMode=process on the unit.
      const managed: ManagedEntry = { ...record, tabId: tabId ?? record.tabId ?? null, child: null };
      if (!isEntryAlive(managed)) continue;
      setEntry(managed);
      adopted += 1;
    }
    diag.log("ttyd", "adopt.summary", {
      adopted,
      reapedDuplicates,
      reapedUnknown,
      scanned: records.length,
    });
    return { adopted, reapedDuplicates, reapedUnknown };
  }

  function shutdown() {
    // Intentionally does NOT signal entries. ttyds are spawned detached so
    // they outlive the daemon; they get adopted back on the next boot. Use
    // release(key) to terminate a specific session, or rely on the OS to
    // reap them on user logout / reboot.
    entries.clear();
    tabIndex.clear();
    reservedPorts.clear();
    inflight.clear();
  }

  function toEntry(entry: ManagedEntry): TtydEntry {
    const { child: _child, ...rest } = entry;
    void _child;
    return { ...rest } as TtydEntry;
  }

  // Expose the resolved publicPath helper to callers via the returned object.
  const manager: TtydManager = {
    ensure,
    lookup,
    release,
    releaseTab,
    list,
    cleanupStale,
    adopt,
    shutdown,
    config: { ...config, publicPath: () => publicPathFor("") },
  };
  return Object.assign(manager, { publicPathFor });
}

// Build the shell command ttyd runs to attach to the named tmux session.
// Mouse-related options are session-scoped (`-t "${safe}"`, no `-g`) so they
// affect only the cockpit tab being attached, not every pane on the shared
// citadel tmux server. Claude Code keeps xterm-native wheel behavior; shells
// and runtimes that grab DEC mouse tracking ask tmux to own wheel scrollback.
export function buildAttachCommand(tmuxSession: string, options: { enableMouse: boolean }) {
  const safe = tmuxSession.replace(/"/g, '\\"');
  // Inline socket flag so the shell ttyd execs into talks to the same tmux
  // server citadel uses everywhere else (citadel-tmux.service). Without this,
  // `tmux attach` would hit the user's default socket and silently miss the
  // session.
  const tmux = ["tmux", ...tmuxPrefix()].map((arg) => arg.replace(/"/g, '\\"')).join(" ");
  const lines = [
    `${tmux} set-option -s extended-keys on >/dev/null 2>&1 || true`,
    `${tmux} show-options -s -g terminal-features 2>/dev/null | grep -q 'xterm\\*.*extkeys' || ${tmux} set-option -as terminal-features ',xterm*:extkeys' >/dev/null 2>&1 || true`,
  ];
  if (options.enableMouse) {
    // Pairing: mouse routes wheel events in plain panes into tmux copy-mode;
    // set-clipboard lets tmux copy-mode selections reach OSC 52, where the
    // iframe shim writes the decoded text to navigator.clipboard.
    lines.push(`${tmux} set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`);
    lines.push(`${tmux} set-option -t "${safe}" history-limit 50000 >/dev/null 2>&1 || true`);
    lines.push(`${tmux} set-option -t "${safe}" set-clipboard on >/dev/null 2>&1 || true`);
  }
  lines.push(`exec ${tmux} attach -t "${safe}"`);
  return lines.join("; ");
}

function tmuxSessionAlive(name: string) {
  try {
    execFileSync("tmux", [...tmuxPrefix(), "has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function binaryExists(absolutePath: string) {
  try {
    execFileSync(absolutePath, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (alive: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    // 500ms — closed local ports return ECONNREFUSED immediately and open
    // ports connect in <1ms, so this timeout only fires when the kernel is
    // overloaded (spawn storms). The earlier 150ms ceiling produced false
    // negatives during `make deploy` that surfaced as ttyd_start_timeout.
    socket.setTimeout(500, () => finish(false));
  });
}

async function reserveFreePort(base: number, max: number, reserved: Set<number>) {
  const occupied = listListeningPortsInRange(base, max);
  for (let port = base; port <= max; port += 1) {
    if (reserved.has(port)) continue;
    if (occupied.has(port)) continue;
    if (await portOpen(port)) continue;
    reserved.add(port);
    return port;
  }
  throw new TtydUnavailableError("no_free_port", `no free port between ${base} and ${max}`);
}

async function waitForOwnedPort(port: number, pid: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const owner = listeningPidForPort(port);
    if (owner === pid) return true;
    // If lsof is unavailable in a test/dev environment, fall back to the old
    // readiness probe. In production, a known-but-wrong owner must not satisfy
    // readiness; that is how a ttyd launched for session A can accidentally
    // serve session B's iframe as a white 404 page.
    if (owner === undefined && (await portOpen(port))) return true;
    if (pid > 0 && !processAlive(pid)) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
