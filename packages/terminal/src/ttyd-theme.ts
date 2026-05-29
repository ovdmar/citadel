import { tmuxPrefix } from "./tmux-prefix.js";
import type { TtydTheme } from "./ttyd-types.js";

/**
 * Build the `-t` ttyd client-option flags that paint xterm to match the
 * cockpit theme. Palette is derived from the meshes-studio design system
 * (warm beige + navy for light, deep navy + soft white for dark) so the
 * terminal blends with the rest of the UI.
 */
export function ttydThemeArgs(theme: TtydTheme): string[] {
  const palette = theme === "light" ? LIGHT_XTERM_THEME : DARK_XTERM_THEME;
  return [
    "-t",
    `theme=${JSON.stringify(palette)}`,
    "-t",
    "fontFamily=ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    // Auto-reconnect 3s after the websocket drops (laptop sleep, network
    // blip). Without this, ttyd's xterm shows "Press any key to reconnect"
    // and waits for a manual key press.
    "-t",
    "reconnect=3",
  ];
}

export function buildAttachCommand(tmuxSession: string, options: { enableMouse: boolean }) {
  const safe = tmuxSession.replace(/"/g, '\\"');
  // Inline socket flag so the shell ttyd execs into talks to the same tmux
  // server citadel uses everywhere else (citadel-tmux.service). Without this,
  // `tmux attach` would hit the user's default socket and silently miss the
  // session.
  const tmux = ["tmux", ...tmuxPrefix()].map((arg) => arg.replace(/"/g, '\\"')).join(" ");
  const lines = [
    `${tmux} set-option -s extended-keys on >/dev/null 2>&1 || true`,
    `${tmux} show-options -s -g terminal-features 2>/dev/null | grep -q 'xterm\\*.*extkeys' || ${tmux} set-option -as terminal-features ',xterm*:extkeys' >/dev/null 2>&1 || true`,
  ];
  if (options.enableMouse) {
    // Scope mouse to this tmux session only (`-t <session>`) — runtimes that
    // grab DEC mouse tracking (codex, cursor-agent) need tmux to intercept
    // wheel events for scrollback, but runtimes that don't (claude-code) get
    // smoother native xterm.js wheel scroll without tmux in the path.
    lines.push(`${tmux} set-option -t "${safe}" mouse on >/dev/null 2>&1 || true`);
  }
  lines.push(`exec ${tmux} attach -t "${safe}"`);
  return lines.join("; ");
}

export function themeFromJson(themeJson: string | null): TtydTheme {
  if (themeJson?.includes(`"${LIGHT_XTERM_THEME.background}"`)) return "light";
  return "dark";
}

// Palette matches the cockpit's warm-cream redesign so the terminal pane
// reads as part of the surface, not a stark white island. Background tracks
// --c-elev (the stage card colour); foreground tracks --c-fg-1. Ansi colour
// hues are unchanged from the previous palette — only their saturation has
// been pushed up so each colour reads clearly on the cream/dark surfaces
// without losing the warm-leaning character of the cockpit.
// `white` (ansi 7) and `brightWhite` (ansi 15) are deliberately remapped to
// dark values on the light theme: a program that explicitly prints white text
// would otherwise be invisible on the cream surface. Everything else is the
// same hue as before, just dropped in lightness so it reads cleanly on a
// light background — pulling the bright variants down at the same time so
// the "bright" tier stays distinguishable from base without going pastel.
const LIGHT_XTERM_THEME = {
  background: "#f5f1e8",
  foreground: "#1a1814",
  cursor: "#14171f",
  cursorAccent: "#f5f1e8",
  selectionBackground: "rgba(20, 23, 31, 0.18)",
  black: "#1a1814",
  red: "#9a1d12",
  green: "#36680c",
  yellow: "#825507",
  blue: "#194d8e",
  magenta: "#5f2a7a",
  cyan: "#0a5d6e",
  white: "#1a1814",
  brightBlack: "#4a463e",
  brightRed: "#b8281c",
  brightGreen: "#4a8a14",
  brightYellow: "#a06b0a",
  brightBlue: "#2864ad",
  brightMagenta: "#7d3a98",
  brightCyan: "#0f7d92",
  brightWhite: "#0c0a06",
};

const DARK_XTERM_THEME = {
  background: "#1a1814",
  foreground: "#e8e3d3",
  cursor: "#f0ebdd",
  cursorAccent: "#1a1814",
  selectionBackground: "rgba(240, 235, 221, 0.18)",
  black: "#1a1814",
  red: "#ec7468",
  green: "#a3d364",
  yellow: "#e8b552",
  blue: "#7eb5e4",
  magenta: "#c896d4",
  cyan: "#7dbedc",
  white: "#e8e3d3",
  brightBlack: "#948d7b",
  brightRed: "#ff8d80",
  brightGreen: "#bbe683",
  brightYellow: "#f5c66a",
  brightBlue: "#a2cef0",
  brightMagenta: "#dcb1e4",
  brightCyan: "#9ad0e8",
  brightWhite: "#fffaef",
};
