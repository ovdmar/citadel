import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import net from "node:net";

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
  portBase: Number.parseInt(process.env.CITADEL_TTYD_PORT_BASE ?? "", 10) || 7681,
  portMax: Number.parseInt(process.env.CITADEL_TTYD_PORT_MAX ?? "", 10) || 7720,
  basePathPrefix: "/terminals",
  readyTimeoutMs: 4000,
};

export class TtydUnavailableError extends Error {
  readonly code: "ttyd_missing" | "no_free_port" | "ttyd_start_timeout" | "tmux_session_missing" | "spawn_failed";
  constructor(code: TtydUnavailableError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TtydUnavailableError";
  }
}

type ManagedEntry = TtydEntry & { child: ChildProcess };

export type TtydManager = {
  ensure(input: {
    key: string;
    tmuxSession: string;
    worktreePath?: string | null;
    /** Cockpit-resolved theme used to spawn ttyd with the matching xterm palette. Defaults to "dark". */
    theme?: TtydTheme;
  }): Promise<TtydEntry>;
  lookup(key: string): TtydEntry | null;
  release(key: string): void;
  list(): TtydEntry[];
  cleanupStale(): { killed: number; portRange: [number, number] };
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
  }): Promise<TtydEntry> {
    // ttyd bakes the xterm palette at spawn time, so the theme passed here
    // only takes effect when we actually spawn a new ttyd. We deliberately
    // do NOT respawn when an existing entry's theme differs from desired —
    // that triggered visible reconnect storms whenever the user toggled
    // cockpit theme. Terminal palette updates on the next reload instead.
    const desiredTheme: TtydTheme = args.theme ?? "dark";
    const existing = entries.get(args.key);
    if (existing && existing.child.exitCode === null) {
      if (await portOpen(existing.port)) return toEntry(existing);
      try {
        existing.child.kill("SIGTERM");
      } catch {
        // ignore
      }
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
    const attachCommand = buildAttachCommand(args.tmuxSession);
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
        { detached: false, stdio: "ignore" },
      );
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
    if (!entry || entry.child.exitCode !== null) return null;
    return toEntry(entry);
  }

  function release(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    try {
      entry.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    entries.delete(key);
  }

  function list() {
    return Array.from(entries.values())
      .filter((entry) => entry.child.exitCode === null)
      .map(toEntry);
  }

  function cleanupStale() {
    const killed = killStaleTtydInRange(config.portBase, config.portMax);
    return { killed, portRange: [config.portBase, config.portMax] as [number, number] };
  }

  function shutdown() {
    for (const entry of entries.values()) {
      try {
        entry.child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
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
const LIGHT_XTERM_THEME = {
  background: "#f5f1e8",
  foreground: "#1a1814",
  cursor: "#14171f",
  cursorAccent: "#f5f1e8",
  selectionBackground: "rgba(20, 23, 31, 0.18)",
  black: "#1a1814",
  red: "#b8281c",
  green: "#4a8a14",
  yellow: "#a06b0a",
  blue: "#1f5aa6",
  magenta: "#7a3a96",
  cyan: "#0f7d92",
  white: "#c9c2b0",
  brightBlack: "#6f695d",
  brightRed: "#d83a26",
  brightGreen: "#5fa024",
  brightYellow: "#c08418",
  brightBlue: "#3a78c0",
  brightMagenta: "#9c52b8",
  brightCyan: "#1f95ad",
  brightWhite: "#1a1814",
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

function buildAttachCommand(tmuxSession: string) {
  const safe = tmuxSession.replace(/"/g, '\\"');
  return [
    "tmux set-option -s extended-keys on >/dev/null 2>&1 || true",
    "tmux show-options -s -g terminal-features 2>/dev/null | grep -q 'xterm\\*.*extkeys' || tmux set-option -as terminal-features ',xterm*:extkeys' >/dev/null 2>&1 || true",
    `exec tmux attach -t "${safe}"`,
  ].join("; ");
}

function tmuxSessionAlive(name: string) {
  try {
    execFileSync("tmux", ["has-session", "-t", name], { stdio: "ignore" });
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
    socket.setTimeout(150, () => finish(false));
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

function killStaleTtydInRange(portBase: number, portMax: number) {
  let lsofOutput = "";
  try {
    lsofOutput = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return 0;
  }
  const pids = new Set<number>();
  for (const line of lsofOutput.split("\n")) {
    if (!line.includes("ttyd")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    const pid = Number(parts[1]);
    const name = parts[0];
    const address = parts[8] ?? "";
    const portMatch = /:(\d+)$/.exec(address);
    const port = portMatch ? Number(portMatch[1]) : Number.NaN;
    if (name === "ttyd" && Number.isFinite(pid) && port >= portBase && port <= portMax) pids.add(pid);
  }
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
