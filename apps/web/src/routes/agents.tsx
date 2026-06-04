import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { AgentTemplatesPanel } from "../agent-templates-panel.js";
import { useStateQuery } from "../app-state.js";
import { ThemeControls } from "../theme-controls.js";

export function AgentTemplatesView() {
  const state = useStateQuery();
  return (
    <div className="set-app">
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
            /
          </span>
          <div className="set-brand-text">
            <div className="set-brand-name">Agents</div>
            <div className="set-brand-crumb">Templates</div>
          </div>
        </div>
        <div />
        <div className="set-top-right">
          <ThemeControls />
        </div>
      </header>
      <main className="set-content" style={{ maxWidth: 1120, margin: "0 auto", width: "100%" }}>
        <div className="set-page-head">
          <h2 className="set-page-title">Agents</h2>
          <div className="set-page-sub">Predefined roles and built-in actions.</div>
        </div>
        <AgentTemplatesPanel runtimes={state.data?.agentRuntimes ?? []} />
      </main>
    </div>
  );
}
