import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeControls() {
  const [theme, setTheme] = useState(() => localStorage.getItem("citadel.theme") || "system");
  useEffect(() => {
    localStorage.setItem("citadel.theme", theme);
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  const pick = (next: string) => {
    if (next === theme) return;
    setTheme(next);
    // ttyd embeds the xterm palette at spawn time, so running terminals
    // keep their current colors until they're respawned. Offer a reload
    // so the user gets a consistent palette across the whole cockpit.
    const reload = window.confirm(
      "Theme updated. Open terminals will keep their current palette until you reload — reload now?",
    );
    if (reload) window.location.reload();
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
