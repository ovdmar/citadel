import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { tmuxPrefix } from "./index.js";

export type TtydTheme = "light" | "dark";

export type TtydEntry = {
  key: string;
  port: number;
  pid: number;
  basePath: string;
  tmuxSession: string;
  worktreePath: string | null;
  startedAt: string;
  theme: TtydTheme;
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
  release(key: string): void;
  list(): TtydEntry[];
  cleanupStale(): { killed: number; portRange: [number, number] };
  /**
   * Adopt ttyd processes left behind by a previous daemon incarnation.
   * Called at boot with the output of `discoverExistingTtyds()` — adopted
   * entries reuse the same `TtydEntry` shape but have no in-process
   * ChildProcess handle (liveness/kill go via PID). If multiple records
   * share a key (zombies from prior racey respawns), the oldest wins and
   * the rest get SIGTERMed.
   */
  adopt(records: TtydEntry[]): { adopted: number; reapedDuplicates: number };
  shutdown(): void;
  config: Required<Omit<TtydManagerConfig, "publicPath">> & Pick<TtydManagerConfig, "publicPath">;
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
  const entries = new Map<string, ManagedEntry>();
  const reservedPorts = new Set<number>();

  const publicPathFor = (key: string) =>
    config.publicPath ? config.publicPath(key) : `/${config.basePathPrefix}/${encodeURIComponent(key)}/`;

  async function ensure(args: {
    key: string;
    tmuxSession: string;
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
    const desiredTheme: TtydTheme = args.theme ?? "dark";
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
      if (!args.force) return toEntry(existing);
      signalEntry(existing, "SIGTERM");
      entries.delete(args.key);
    }
    if (!tmuxSessionAlive(args.tmuxSession)) {
      throw new TtydUnavailableError("tmux_session_missing", `tmux session ${args.tmuxSession} not found`);
    }
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
          "10",
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
      child,
    };
    entries.set(args.key, record);
    child.on("exit", () => {
      reservedPorts.delete(port);
      const current = entries.get(args.key);
      if (current && current.pid === record.pid) entries.delete(args.key);
    });
    const ready = await waitForPort(port, config.readyTimeoutMs);
    if (!ready) {
      entries.delete(args.key);
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
      entries.delete(key);
      return null;
    }
    return toEntry(entry);
  }

  function release(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    signalEntry(entry, "SIGTERM");
    entries.delete(key);
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

  function adopt(records: TtydEntry[]): { adopted: number; reapedDuplicates: number } {
    let adopted = 0;
    let reapedDuplicates = 0;
    // Sort by startedAt ascending so we keep the OLDEST ttyd per key — that
    // is the one the cockpit iframe is most likely already talking to. Any
    // newer duplicates (from prior race-condition respawns across daemon
    // restarts) get SIGTERMed to free the port + tmux client slot.
    const sorted = [...records].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const record of sorted) {
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
      // Adopted entries have no live ChildProcess — only the PID. They are
      // ttyds spawned by a previous daemon incarnation that survived
      // restart thanks to detached:true + KillMode=process on the unit.
      const managed: ManagedEntry = { ...record, child: null };
      if (!isEntryAlive(managed)) continue;
      entries.set(record.key, managed);
      adopted += 1;
    }
    return { adopted, reapedDuplicates };
  }

  function shutdown() {
    // Intentionally does NOT signal entries. ttyds are spawned detached so
    // they outlive the daemon; they get adopted back on the next boot. Use
    // release(key) to terminate a specific session, or rely on the OS to
    // reap them on user logout / reboot.
    entries.clear();
    reservedPorts.clear();
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
    list,
    cleanupStale,
    adopt,
    shutdown,
    config: { ...config, publicPath: () => publicPathFor("") },
  };
  return Object.assign(manager, { publicPathFor });
}

/**
 * Build the `-t` ttyd client-option flags that paint xterm to match the
 * cockpit theme. Palette is derived from the meshes-studio design system
 * (warm beige + navy for light, deep navy + soft white for dark) so the
 * terminal blends with the rest of the UI.
 */
function ttydThemeArgs(theme: TtydTheme): string[] {
  const palette = theme === "light" ? LIGHT_XTERM_THEME : DARK_XTERM_THEME;
  return [
    "-t",
    `theme=${JSON.stringify(palette)}`,
    "-t",
    "fontFamily=ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    // Auto-reconnect 3s after the websocket drops (laptop sleep, network
    // blip). Without this, ttyd's xterm shows "Press any key to reconnect"
    // and waits for a manual key press.
    "-t",
    "reconnect=3",
  ];
}

// Palette matches the cockpit's warm-cream redesign so the terminal pane
// reads as part of the surface, not a stark white island. Background tracks
// --c-elev (the stage card colour); foreground tracks --c-fg-1. Ansi colour
// hues are unchanged from the previous palette — only their saturation has
// been pushed up so each colour reads clearly on the cream/dark surfaces
// without losing the warm-leaning character of the cockpit.
// `white` (ansi 7) and `brightWhite` (ansi 15) are deliberately remapped to
// dark values on the light theme: a program that explicitly prints white text
// would otherwise be invisible on the cream surface. Everything else is the
// same hue as before, just dropped in lightness so it reads cleanly on a
// light background — pulling the bright variants down at the same time so
// the "bright" tier stays distinguishable from base without going pastel.
const LIGHT_XTERM_THEME = {
  background: "#f5f1e8",
  foreground: "#1a1814",
  cursor: "#14171f",
  cursorAccent: "#f5f1e8",
  selectionBackground: "rgba(20, 23, 31, 0.18)",
  black: "#1a1814",
  red: "#9a1d12",
  green: "#36680c",
  yellow: "#825507",
  blue: "#194d8e",
  magenta: "#5f2a7a",
  cyan: "#0a5d6e",
  white: "#1a1814",
  brightBlack: "#4a463e",
  brightRed: "#b8281c",
  brightGreen: "#4a8a14",
  brightYellow: "#a06b0a",
  brightBlue: "#2864ad",
  brightMagenta: "#7d3a98",
  brightCyan: "#0f7d92",
  brightWhite: "#0c0a06",
};

const DARK_XTERM_THEME = {
  background: "#1a1814",
  foreground: "#e8e3d3",
  cursor: "#f0ebdd",
  cursorAccent: "#1a1814",
  selectionBackground: "rgba(240, 235, 221, 0.18)",
  black: "#1a1814",
  red: "#ec7468",
  green: "#a3d364",
  yellow: "#e8b552",
  blue: "#7eb5e4",
  magenta: "#c896d4",
  cyan: "#7dbedc",
  white: "#e8e3d3",
  brightBlack: "#948d7b",
  brightRed: "#ff8d80",
  brightGreen: "#bbe683",
  brightYellow: "#f5c66a",
  brightBlue: "#a2cef0",
  brightMagenta: "#dcb1e4",
  brightCyan: "#9ad0e8",
  brightWhite: "#fffaef",
};

function buildAttachCommand(tmuxSession: string, options: { enableMouse: boolean }) {
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
    // Scope mouse to this tmux session only (`-t <session>`) — runtimes that
    // grab DEC mouse tracking (codex, cursor-agent) need tmux to intercept
    // wheel events for scrollback, but runtimes that don't (claude-code) get
    // smoother native xterm.js wheel scroll without tmux in the path.
    lines.push(`${tmux} set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`);
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
  for (let port = base; port <= max; port += 1) {
    if (reserved.has(port)) continue;
    if (await portOpen(port)) continue;
    reserved.add(port);
    return port;
  }
  throw new TtydUnavailableError("no_free_port", `no free port between ${base} and ${max}`);
}

async function waitForPort(port: number, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await portOpen(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function listListeningTtydsInRange(portBase: number, portMax: number): Map<number, number> {
  const pidPort = new Map<number, number>();
  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return pidPort;
  }
  for (const line of lsofOutput.split("\n")) {
    if (!line.includes("ttyd")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    const name = parts[0];
    const address = parts[8] ?? "";
    const portMatch = /:(\d+)$/.exec(address);
    const port = portMatch ? Number(portMatch[1]) : Number.NaN;
    if (name === "ttyd" && Number.isFinite(pid) && port >= portBase && port <= portMax) pidPort.set(pid, port);
  }
  return pidPort;
}

function killStaleTtydInRange(portBase: number, portMax: number) {
  const pids = new Set(listListeningTtydsInRange(portBase, portMax).keys());
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
  }
  return pids.size;
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Scan the host for ttyd processes left behind by a previous daemon
 * incarnation that we can re-attach to instead of killing-and-respawning.
 * Filters by port range so we never touch a ttyd a different Citadel
 * checkout owns (each worktree gets its own slot via ttyd-slot.ts) and by
 * the `-b /<basePathPrefix>/<key>` argv shape so non-Citadel ttyds in the
 * range are ignored.
 *
 * Linux-only — relies on `/proc/<pid>/cmdline`. On other platforms returns
 * an empty list (caller falls back to spawning fresh ttyds).
 */
export function discoverExistingTtyds(
  opts: {
    portBase?: number;
    portMax?: number;
    basePathPrefix?: string;
  } = {},
): TtydEntry[] {
  const portBase = opts.portBase ?? DEFAULTS.portBase;
  const portMax = opts.portMax ?? DEFAULTS.portMax;
  const basePathPrefix = trimSlashes(opts.basePathPrefix ?? DEFAULTS.basePathPrefix);
  const found: TtydEntry[] = [];
  for (const [pid, port] of listListeningTtydsInRange(portBase, portMax)) {
    const entry = readTtydEntryFromProc(pid, port, basePathPrefix);
    if (entry) found.push(entry);
  }
  return found;
}

function readTtydEntryFromProc(pid: number, port: number, basePathPrefix: string): TtydEntry | null {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return null;
  }
  const args = raw.split("\0").filter((arg) => arg.length > 0);
  let basePath: string | null = null;
  let themeJson: string | null = null;
  for (let i = 0; i < args.length - 1; i++) {
    const flag = args[i];
    const value = args[i + 1] ?? "";
    if (flag === "-b") basePath = value;
    if (flag === "-t" && value.startsWith("theme=")) themeJson = value.slice("theme=".length);
  }
  if (!basePath) return null;
  const prefix = `/${basePathPrefix}/`;
  if (!basePath.startsWith(prefix)) return null;
  const key = decodeURIComponent(basePath.slice(prefix.length));
  if (!key) return null;
  // The shell command is the last argv after the shell binary and `-lc`.
  // It looks like `…; exec tmux … attach -t "<session>"`.
  const attachCommand = args[args.length - 1] ?? "";
  const sessionMatch = /attach\s+-t\s+"((?:\\.|[^"\\])+)"/.exec(attachCommand);
  const sessionRaw = sessionMatch?.[1];
  if (!sessionRaw) return null;
  const tmuxSession = sessionRaw.replace(/\\(.)/g, "$1");
  // Theme: match by the unique light/dark background hex; default to dark.
  let theme: TtydTheme = "dark";
  if (themeJson) {
    if (themeJson.includes(`"${LIGHT_XTERM_THEME.background}"`)) theme = "light";
    else if (themeJson.includes(`"${DARK_XTERM_THEME.background}"`)) theme = "dark";
  }
  let startedAt = new Date().toISOString();
  try {
    const stat = fs.statSync(`/proc/${pid}`);
    startedAt = stat.ctime.toISOString();
  } catch {
    // ignore — falls back to "now", harmless for callers.
  }
  return { key, port, pid, basePath, tmuxSession, worktreePath: null, startedAt, theme };
}
