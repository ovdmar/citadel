import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { TtydEntry, TtydTheme } from "./ttyd.js";

const LIGHT_BACKGROUND = "#f5f1e8";
const DARK_BACKGROUND = "#1a1814";

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

function listListeningTtyds(): Map<number, number> {
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
    const address = parts[8] ?? "";
    const portMatch = /:(\d+)$/.exec(address);
    const port = portMatch ? Number(portMatch[1]) : Number.NaN;
    if (parts[0] === "ttyd" && Number.isFinite(pid) && Number.isFinite(port)) pidPort.set(pid, port);
  }
  return pidPort;
}

/**
 * Scan the host for ttyd processes left behind by a previous daemon
 * incarnation that we can re-attach to instead of killing-and-respawning.
 * Filters by the `-b /<basePathPrefix>/<key>` argv shape, not by port range,
 * so adoption can also reap legacy ttyds from older port-slot schemes.
 */
export function discoverExistingTtyds(opts: { basePathPrefix?: string } = {}): TtydEntry[] {
  const basePathPrefix = trimSlashes(opts.basePathPrefix ?? "/terminals");
  const found: TtydEntry[] = [];
  for (const [pid, port] of listListeningTtyds()) {
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
  const attachCommand = args[args.length - 1] ?? "";
  const sessionMatch = /attach\s+-t\s+"((?:\\.|[^"\\])+)"/.exec(attachCommand);
  const sessionRaw = sessionMatch?.[1];
  if (!sessionRaw) return null;
  const tmuxSession = sessionRaw.replace(/\\(.)/g, "$1");
  let theme: TtydTheme = "dark";
  if (themeJson) {
    if (themeJson.includes(`"${LIGHT_BACKGROUND}"`)) theme = "light";
    else if (themeJson.includes(`"${DARK_BACKGROUND}"`)) theme = "dark";
  }
  let startedAt = new Date().toISOString();
  try {
    startedAt = fs.statSync(`/proc/${pid}`).ctime.toISOString();
  } catch {
    // fall back to now
  }
  return { key, port, pid, basePath, tmuxSession, worktreePath: null, startedAt, theme, tabId: null };
}
