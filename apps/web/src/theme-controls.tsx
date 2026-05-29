import { Monitor, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { type ThemePreference, applyThemePreference, readThemePreference } from "./use-resolved-theme.js";

export function ThemeControls() {
  const [theme, setTheme] = useState<ThemePreference>(() => readThemePreference());

  const pick = (next: ThemePreference) => {
    if (next === theme && next === readThemePreference()) return;
    applyThemePreference(next);
    setTheme(next);
  };

  return (
    <div className="theme">
      <button type="button" aria-label="System theme" onClick={() => pick("system")}>
        <Monitor size={16} />
      </button>
      <button type="button" aria-label="Light theme" onClick={() => pick("light")}>
        <Sun size={16} />
      </button>
      <button type="button" aria-label="Dark theme" onClick={() => pick("dark")}>
        <Moon size={16} />
      </button>
    </div>
  );
}
