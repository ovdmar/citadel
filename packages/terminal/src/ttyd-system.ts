import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { tmuxPrefix } from "./index.js";
import { TtydUnavailableError } from "./ttyd-errors.js";
import type { TtydEntry, TtydTheme } from "./ttyd.js";

export function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
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

export function discoverExistingTtydsFromProc(opts: {
  basePathPrefix?: string;
  portBase?: number;
  portMax?: number;
  lightThemeBackground: string;
  darkThemeBackground: string;
}): TtydEntry[] {
  const basePathPrefix = trimSlashes(opts.basePathPrefix ?? "terminals");
  const portBase = opts.portBase ?? 0;
  const portMax = opts.portMax ?? Number.MAX_SAFE_INTEGER;
  const found: TtydEntry[] = [];
  for (const [pid, port] of listListeningTtydsInRange(portBase, portMax)) {
    const entry = readTtydEntryFromProc(pid, port, basePathPrefix, opts);
    if (entry) found.push(entry);
  }
  return found;
}

function readTtydEntryFromProc(
  pid: number,
  port: number,
  basePathPrefix: string,
  themes: { lightThemeBackground: string; darkThemeBackground: string },
): TtydEntry | null {
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
    if (flag === "-t" && value === "theme") themeJson = args[i + 2] ?? null;
  }
  if (!basePath) return null;
  const prefix = `/${basePathPrefix}/`;
  if (!basePath.startsWith(prefix)) return null;
  const key = decodeURIComponent(basePath.slice(prefix.length));
  if (!key) return null;
  const attachCommand = args[args.length - 1] ?? "";
  const sessionMatch = /attach\s+-t\s+"((?:\\.|[^"\\])+)"/.exec(attachCommand);
  const sessionRaw = sessionMatch?.[1];
  if (!sessionRaw) return null;
  const tmuxSession = sessionRaw.replace(/\\(.)/g, "$1");
  let theme: TtydTheme = "dark";
  if (themeJson) {
    if (themeJson.includes(`"${themes.lightThemeBackground}"`)) theme = "light";
    else if (themeJson.includes(`"${themes.darkThemeBackground}"`)) theme = "dark";
  }
  let startedAt = new Date().toISOString();
  try {
    const stat = fs.statSync(`/proc/${pid}`);
    startedAt = stat.ctime.toISOString();
  } catch {
    // ignore
  }
  return { key, port, pid, basePath, tmuxSession, worktreePath: null, startedAt, theme, tabId: null };
}
