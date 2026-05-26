// Daemon target resolution for the satellite app.
//
// We default to the long-term systemd daemon on 127.0.0.1:4010 (per CLAUDE.md
// and consistent with scripts/mac-satellite/quick-capture.sh). Worktree-isolated
// daemons (4110+) are deliberately NOT auto-discovered — a global shortcut
// bound at the OS level can't know which worktree is "active". Users who want
// a worktree-specific binding set CITADEL_HOST / CITADEL_PORT in the shortcut's
// environment.

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4010;

export type DaemonTarget = {
  host: string;
  port: number;
  origin: string;
  quickCaptureUrl: string;
  newWorkspaceUrl: string;
  livenessUrl: string;
};

export function resolveDaemonTarget(env: NodeJS.ProcessEnv = process.env): DaemonTarget {
  const host = (env.CITADEL_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const portRaw = (env.CITADEL_PORT ?? "").trim();
  const portParsed = Number.parseInt(portRaw, 10);
  const port = Number.isFinite(portParsed) && portParsed > 0 ? portParsed : DEFAULT_PORT;
  const origin = `http://${host}:${port}`;
  return {
    host,
    port,
    origin,
    quickCaptureUrl: `${origin}/quick-capture`,
    newWorkspaceUrl: `${origin}/?modal=new-workspace`,
    livenessUrl: `${origin}/api/scratchpad`,
  };
}

// Spotlight-shaped popup geometry. Width keeps the textarea ~60-char wide; the
// height accommodates the textarea, mic button, and status line without
// scrolling. Caller centers horizontally on the active display.
export const QUICK_CAPTURE_WINDOW = {
  width: 640,
  height: 220,
} as const;

export function centerOnDisplay(
  display: { workArea: { x: number; y: number; width: number; height: number } },
  win: { width: number; height: number } = QUICK_CAPTURE_WINDOW,
): { x: number; y: number; width: number; height: number } {
  const { workArea } = display;
  return {
    width: win.width,
    height: win.height,
    x: Math.round(workArea.x + (workArea.width - win.width) / 2),
    // Position slightly above center, Spotlight-style — the eye tracks higher
    // than dead-center on a screen, and below-content space is desirable.
    y: Math.round(workArea.y + workArea.height * 0.28),
  };
}
