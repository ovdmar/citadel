import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEventRefresh, useStateQuery } from "../app-state.js";
import { ScheduledAgentsPanel } from "../settings-scheduled-agents.js";

export function ScheduledAgentsView() {
  const state = useStateQuery();
  useEventRefresh();
  return (
    <div className="page dashboard-page sched-page" style={{ padding: 0 }}>
      <header className="dashboard-header" aria-label="Scheduled agents navigation">
        <Link to="/" className="dashboard-back" title="Back to cockpit" aria-label="Back to cockpit">
          <ArrowLeft size={14} /> Cockpit
        </Link>
        <span className="dashboard-title">Scheduled agents</span>
      </header>
      <div className="sched-body">
        <ScheduledAgentsPanel state={state.data} />
      </div>
    </div>
  );
}
