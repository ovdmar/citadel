import { Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useEventRefresh, useStateQuery } from "../app-state.js";
import { ScheduledAgentsPanel } from "../settings-scheduled-agents.js";

export function ScheduledAgentsView() {
  const state = useStateQuery();
  useEventRefresh();
  return (
    <div className="set-app sched-page">
      <header className="set-topbar">
        <div className="set-brand">
          <Link to="/" className="set-back" aria-label="Back to cockpit">
            <span className="set-back-icon">
              <ArrowLeft size={13} />
            </span>
            <span className="set-back-text">
              <span className="set-back-eyebrow">Citadel</span>
              <span className="set-back-label">Cockpit</span>
            </span>
          </Link>
          <span className="set-brand-sep" aria-hidden>
            ›
          </span>
          <div className="set-brand-text">
            <div className="set-brand-name">Scheduled agents</div>
            <div className="set-brand-crumb">Cron-driven runs</div>
          </div>
        </div>

        <div />

        <div className="set-top-right">
          <ThemeToggle />
          <Link to="/settings" className="set-top-link">
            Settings
          </Link>
          <Link to="/" className="set-top-link">
            Workspaces
          </Link>
        </div>
      </header>

      <main className="set-content">
        <div className="set-page-head">
          <div className="set-page-title">
            <Clock size={20} style={{ verticalAlign: "-3px", marginRight: 8, color: "var(--c-fg-3)" }} />
            Scheduled agents
          </div>
          <div className="set-page-sub">Cron-driven agent runs.</div>
          <div className="set-page-help">
            Scheduled agents start a session on a cron (or one-shot) schedule, using the same MCPs and CLIs as
            interactive runs. If you want output to land in Slack, configure that inside the agent's tools.
          </div>
        </div>
        <ScheduledAgentsPanel state={state.data} />
      </main>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState(() => localStorage.getItem("citadel.theme") || "system");
  useEffect(() => {
    localStorage.setItem("citadel.theme", theme);
    if (theme === "system") {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      className="set-icon-btn"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle theme"
    >
      {isDark ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
