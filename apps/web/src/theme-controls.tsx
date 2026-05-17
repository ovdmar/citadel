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

  return (
    <div className="theme">
      <button type="button" aria-label="System theme" onClick={() => setTheme("system")}>
        <Monitor size={16} />
      </button>
      <button type="button" aria-label="Light theme" onClick={() => setTheme("light")}>
        <Sun size={16} />
      </button>
      <button type="button" aria-label="Dark theme" onClick={() => setTheme("dark")}>
        <Moon size={16} />
      </button>
    </div>
  );
}
