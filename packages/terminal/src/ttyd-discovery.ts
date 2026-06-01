import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { resolveTtydThemeFromJson } from "./ttyd-theme.js";
import type { TtydEntry } from "./ttyd.js";

const DEFAULT_BASE_PATH_PREFIX = "/terminals";

export function listListeningTtydsInRange(portBase: number, portMax: number): Map<number, number> {
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

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
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
  let startedAt = new Date().toISOString();
  try {
    const stat = fs.statSync(`/proc/${pid}`);
    startedAt = stat.ctime.toISOString();
  } catch {
    // ignore — falls back to "now", harmless for callers.
  }
  return {
    key,
    port,
    pid,
    basePath,
    tmuxSession,
    worktreePath: null,
    startedAt,
    theme: resolveTtydThemeFromJson(themeJson),
    tabId: null,
  };
}
