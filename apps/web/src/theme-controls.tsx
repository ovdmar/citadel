import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { type ThemePreference, applyThemePreference, readThemePreference } from "./use-resolved-theme.js";

export type ThemeSetting = ThemePreference;

const STORAGE_KEY = "citadel.theme";
const CYCLE: readonly ThemeSetting[] = ["light", "dark", "system"];

// Reject anything outside the known cycle so a stale or hand-edited
// localStorage value (e.g. "midnight") falls back to "system" instead of
// breaking the toggle.
function normalize(value: string | null): ThemeSetting {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}

function nextInCycle(current: ThemeSetting): ThemeSetting {
  const index = CYCLE.indexOf(current);
  return CYCLE[(index + 1) % CYCLE.length] ?? "system";
}

function describe(theme: ThemeSetting): string {
  switch (theme) {
    case "light":
      return "Light";
    case "dark":
      return "Dark";
    default:
      return "System";
  }
}

/**
 * Single cycling button: Light → Dark → System → Light.
 *
 * The icon reflects the current selection; the aria-label and title name both
 * the current mode and the next click's destination so screen readers and
 * tooltips agree on what will happen.
 *
 * Open terminals subscribe through useResolvedTheme and update their xterm
 * palette in place — this component does NOT prompt for a reload and does NOT
 * call `window.location.reload()`.
 */
export function ThemeControls() {
  const [theme, setTheme] = useState<ThemeSetting>(() => normalize(readThemePreference()));
  const next = nextInCycle(theme);
  const label = `Theme: ${describe(theme)}. Click for ${describe(next)}.`;

  const pick = () => {
    if (next === theme && next === readThemePreference()) return;
    applyThemePreference(next);
    setTheme(next);
  };

  return (
    <button type="button" className="set-icon-btn" onClick={pick} aria-label={label} title={label}>
      <ThemeIcon theme={theme} />
    </button>
  );
}

function ThemeIcon({ theme }: { theme: ThemeSetting }) {
  if (theme === "light") return <Sun size={15} />;
  if (theme === "dark") return <Moon size={15} />;
  return <Monitor size={15} />;
}

// Exported helpers for testing and for the orchestrator's bootstrap path.
export { CYCLE, STORAGE_KEY, describe, nextInCycle, normalize };
