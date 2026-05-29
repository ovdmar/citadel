import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { ttydThemeFromJson } from "./ttyd-theme.js";
import type { TtydEntry } from "./ttyd.js";

const DEFAULT_BASE_PATH_PREFIX = "/terminals";

export function processAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function listeningPidForPort(port: number): number | null | undefined {
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

export function listListeningPortsInRange(portBase: number, portMax: number): Set<number> {
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
  const basePathPrefix = trimSlashes(opts.basePathPrefix ?? DEFAULT_BASE_PATH_PREFIX);
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
  // It looks like `...; exec tmux ... attach -t "<session>"`.
  const attachCommand = args[args.length - 1] ?? "";
  const sessionMatch = /attach\s+-t\s+"((?:\\.|[^"\\])+)"/.exec(attachCommand);
  const sessionRaw = sessionMatch?.[1];
  if (!sessionRaw) return null;
  const tmuxSession = sessionRaw.replace(/\\(.)/g, "$1");
  const theme = ttydThemeFromJson(themeJson);
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
