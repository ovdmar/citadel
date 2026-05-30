import { execFileSync } from "node:child_process";

const configuredTmuxSockets = new Set<string>();

// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket.
export function tmuxPrefix(): string[] {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}

export function ensureTmuxExtendedKeys() {
  const socketKey = process.env.CITADEL_TMUX_SOCKET || "default";
  if (configuredTmuxSockets.has(socketKey)) return;
  execFileSync("tmux", [...tmuxPrefix(), "set-option", "-s", "extended-keys", "on"], { stdio: "ignore" });
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
  configuredTmuxSockets.add(socketKey);
}
