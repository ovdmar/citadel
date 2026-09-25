import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configuredTmuxSockets = new Set<string>();
export const DEFAULT_TMUX_HISTORY_LIMIT = 20_000;
const MIN_TMUX_HISTORY_LIMIT = 1_000;
const MAX_TMUX_HISTORY_LIMIT = 100_000;

export type TmuxSocketName = string | null | undefined;

function configuredDefaultSocket(): string | null {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock && sock.trim().length > 0 ? sock : null;
}

export function tmuxSocketNameForWorkspace(workspaceId: string): string {
  const base = configuredDefaultSocket() ?? "citadel";
  const safeWorkspaceId = workspaceId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `${base}-ws-${safeWorkspaceId}`;
}

// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket.
export function tmuxPrefix(socketName?: TmuxSocketName): string[] {
  const explicit = typeof socketName === "string" && socketName.trim().length > 0 ? socketName : null;
  const sock = explicit ?? configuredDefaultSocket();
  return sock ? ["-L", sock] : [];
}

export function ensureTmuxExtendedKeys(socketName?: TmuxSocketName) {
  const socketKey = tmuxSocketCacheKey(socketName);
  if (!configuredTmuxSockets.has(socketKey)) {
    execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-s", "extended-keys", "on"], { stdio: "ignore" });
    trySetTmuxOption(["set-option", "-s", "extended-keys-format", "csi-u"], socketName);
    const features = execFileSync(
      "tmux",
      [...tmuxPrefix(socketName), "show-options", "-s", "-g", "terminal-features"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (!/xterm\*[^\n]*\bextkeys\b/.test(features)) {
      execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-as", "terminal-features", ",xterm*:extkeys"], {
        stdio: "ignore",
      });
    }
    execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-g", "mouse", "off"], { stdio: "ignore" });
    execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-g", "set-clipboard", "on"], {
      stdio: "ignore",
    });
    configuredTmuxSockets.add(socketKey);
  }
  // Keep enough scrollback for operator inspection while bounding worst-case
  // per-client/server memory in long-running tmux servers.
  execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-g", "history-limit", String(tmuxHistoryLimit())], {
    stdio: "ignore",
  });
}

export function setTmuxMouseForSession(sessionName: string, enabled: boolean, socketName?: TmuxSocketName): void {
  execFileSync("tmux", [...tmuxPrefix(socketName), "set-option", "-t", sessionName, "mouse", enabled ? "on" : "off"], {
    stdio: "ignore",
  });
}

export function tmuxHistoryLimit(): number {
  const raw = process.env.CITADEL_TMUX_HISTORY_LIMIT?.trim();
  if (!raw) return DEFAULT_TMUX_HISTORY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TMUX_HISTORY_LIMIT;
  return Math.min(MAX_TMUX_HISTORY_LIMIT, Math.max(MIN_TMUX_HISTORY_LIMIT, parsed));
}

function trySetTmuxOption(args: string[], socketName?: TmuxSocketName): void {
  try {
    execFileSync("tmux", [...tmuxPrefix(socketName), ...args], { stdio: "ignore" });
  } catch {
    /* unsupported by older tmux */
  }
}

function tmuxSocketCacheKey(socketName?: TmuxSocketName): string {
  const explicit = typeof socketName === "string" && socketName.trim().length > 0 ? socketName : null;
  const label = explicit ?? configuredDefaultSocket() ?? "default";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketPath = path.join(process.env.TMUX_TMPDIR || os.tmpdir(), `tmux-${uid}`, label);
  try {
    const stat = fs.statSync(socketPath);
    return `${socketPath}:${stat.dev}:${stat.ino}:${Math.trunc(stat.ctimeMs)}`;
  } catch {
    return `${socketPath}:missing`;
  }
}
