// Prepended to every tmux invocation. When `CITADEL_TMUX_SOCKET` is set
// (citadel.service does this), tmux talks to its own dedicated server via
// `tmux -L <socket>` instead of the user's default socket.
export function tmuxPrefix(): string[] {
  const sock = process.env.CITADEL_TMUX_SOCKET;
  return sock ? ["-L", sock] : [];
}
