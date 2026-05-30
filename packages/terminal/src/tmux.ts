import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configuredTmuxSockets = new Set<string>();

// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket.
export function tmuxPrefix(): string[] {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}

export function ensureTmuxExtendedKeys() {
  const socketKey = tmuxSocketCacheKey();
  if (configuredTmuxSockets.has(socketKey)) return;
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-s", "extended-keys", "on"], { stdio: "ignore" });
  trySetTmuxOption(["set-option", "-s", "extended-keys-format", "csi-u"]);
  const features = execFileSync("tmux", [...tmuxPrefix(), "show-options", "-s", "-g", "terminal-features"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!/xterm\*[^\n]*\bextkeys\b/.test(features)) {
    execFileSync("tmux", [...tmuxPrefix(), "set-option", "-as", "terminal-features", ",xterm*:extkeys"], {
      stdio: "ignore",
    });
  }
  // Keep enough scrollback for operator inspection while bounding worst-case
  // per-client/server memory in long-running tmux servers.
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-g", "history-limit", "5000"], { stdio: "ignore" });
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-g", "mouse", "on"], { stdio: "ignore" });
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-g", "set-clipboard", "on"], { stdio: "ignore" });
  configuredTmuxSockets.add(socketKey);
}

function trySetTmuxOption(args: string[]): void {
  try {
    execFileSync("tmux", [...tmuxPrefix(), ...args], { stdio: "ignore" });
  } catch {
    /* unsupported by older tmux */
  }
}

function tmuxSocketCacheKey(): string {
  const label = process.env.CITADEL_TMUX_SOCKET || "default";
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const socketPath = path.join(process.env.TMUX_TMPDIR || os.tmpdir(), `tmux-${uid}`, label);
  try {
    const stat = fs.statSync(socketPath);
    return `${socketPath}:${stat.dev}:${stat.ino}:${Math.trunc(stat.ctimeMs)}`;
  } catch {
    return `${socketPath}:missing`;
  }
}
