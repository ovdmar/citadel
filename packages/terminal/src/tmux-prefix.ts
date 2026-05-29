// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket. The server lives
// in citadel-tmux.service's cgroup, not citadel.service's — so daemon
// restarts/upgrades leave the agent sessions untouched. Empty in tests and
// on hosts where the socket isn't configured, preserving legacy behavior.
export function tmuxPrefix(): string[] {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}
