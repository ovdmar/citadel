import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { tmuxPrefix } from "./tmux-prefix.js";
import type { TtydEntry, TtydTheme } from "./ttyd.js";

export const DEFAULTS = {
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

export const TTYD_PING_INTERVAL_SECONDS = 45;

export class TtydUnavailableError extends Error {
  readonly code: "ttyd_missing" | "no_free_port" | "ttyd_start_timeout" | "tmux_session_missing" | "spawn_failed";
  constructor(code: TtydUnavailableError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TtydUnavailableError";
  }
}

/**
 * Build the `-t` ttyd client-option flags that paint xterm to match the
 * cockpit theme. Palette is derived from the meshes-studio design system
 * (warm beige + navy for light, deep navy + soft white for dark) so the
 * terminal blends with the rest of the UI.
 */
export function ttydThemeArgs(theme: TtydTheme): string[] {
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
    // Scope mouse to this tmux session only (`-t <session>`) — runtimes that
    // grab DEC mouse tracking (codex, cursor-agent) need tmux to intercept
    // wheel events for scrollback, but runtimes that don't (claude-code) get
    // smoother native xterm.js wheel scroll without tmux in the path.
    lines.push(`${tmux} set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`);
  }
  lines.push(`exec ${tmux} attach -t "${safe}"`);
  return lines.join("; ");
}

export function tmuxSessionAlive(name: string) {
  try {
    execFileSync("tmux", [...tmuxPrefix(), "has-session", "-t", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function binaryExists(absolutePath: string) {
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

export async function reserveFreePort(base: number, max: number, reserved: Set<number>) {
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

export async function waitForOwnedPort(port: number, pid: number, timeoutMs: number) {
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

function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function listeningPidForPort(port: number): number | null | undefined {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = /^p(\d+)$/m.exec(output);
    return match ? Number(match[1]) : null;
  } catch (error) {
    const status = (error as { status?: unknown }).status;
    if (status === 1) return null;
    return undefined;
  }
}

function listListeningPortsInRange(portBase: number, portMax: number): Set<number> {
  const ports = new Set<number>();
  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ports;
  }
  for (const line of lsofOutput.split("\n")) {
    const match = /TCP .*:(\d+) \(LISTEN\)/.exec(line);
    if (!match) continue;
    const port = Number(match[1]);
    if (port >= portBase && port <= portMax) ports.add(port);
  }
  return ports;
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

export function killStaleTtydInRange(portBase: number, portMax: number) {
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

export function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

/**
 * Scan the host for ttyd processes left behind by a previous daemon
 * incarnation that we can re-attach to instead of killing-and-respawning.
 * Filters by the `-b /<basePathPrefix>/<key>` argv shape (so non-Citadel
 * ttyds are skipped) and, when supplied, the caller's ttyd port range. The
 * range filter is a safety boundary: a sandbox daemon with a fixture DB must
 * not scan host-wide ttyds and SIGTERM production terminals whose keys are
 * absent from the sandbox DB.
 *
 * Linux-only — relies on `/proc/<pid>/cmdline`. On other platforms returns
 * an empty list (caller falls back to spawning fresh ttyds).
 */
export function discoverExistingTtyds(
  opts: {
    basePathPrefix?: string;
    portBase?: number;
    portMax?: number;
  } = {},
): TtydEntry[] {
  const basePathPrefix = trimSlashes(opts.basePathPrefix ?? DEFAULTS.basePathPrefix);
  const portBase = opts.portBase ?? 0;
  const portMax = opts.portMax ?? Number.MAX_SAFE_INTEGER;
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
    // ttyd parses client options in-place and can replace the "=" in
    // `theme=<json>` with NUL, so adopted processes may present as
    // `-t`, `theme`, `<json>` in /proc/<pid>/cmdline.
    if (flag === "-t" && value === "theme") themeJson = args[i + 2] ?? null;
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
  // tabId isn't recoverable from /proc — the ttyd command line doesn't carry
  // it. The adopt() caller resolves it from the DB via the optional
  // `resolveTabId` callback.
  return { key, port, pid, basePath, tmuxSession, worktreePath: null, startedAt, theme, tabId: null };
}
