import type { AgentRuntime, Repo, ScheduledAgent, Workspace } from "@citadel/contracts";
import { History as HistoryIcon, Plus } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { describeCronClient, nextCronRunClient } from "./cron-client.js";
import { Modal } from "./modals.js";
import { ScheduledAgentEditor } from "./scheduled-agent-editor.js";
import { type ScheduledAgentDraft, ScheduledAgentForm, recurringDraftFromAgent } from "./scheduled-agent-form.js";
import { ScheduledAgentsHistoryTimeline } from "./scheduled-agents-history-timeline.js";

type Tab = "upcoming" | "history";

// Top-level Scheduled Agents panel. Owns the tabs, the selected agent in the
// master-detail editor, and the create-agent modal (with optional prefill
// for "Schedule again" from a past one-shot row).
export function ScheduledAgentsPanel(props: { state: StateResponse | undefined }) {
  const repos = props.state?.repos ?? [];
  const runtimes = props.state?.agentRuntimes ?? [];
  const scheduledAgents = props.state?.scheduledAgents ?? [];
  const workspaces = props.state?.workspaces ?? [];

  if (!repos.length) {
    return (
      <div className="settings-stack">
        <p className="settings-hint">
          Register at least one repository before creating a scheduled agent. Scheduled agents run inside a workspace
          attached to a repo.
        </p>
        <div className="empty">No repositories registered.</div>
      </div>
    );
  }

  return (
    <ScheduledAgentsShell repos={repos} runtimes={runtimes} workspaces={workspaces} scheduledAgents={scheduledAgents} />
  );
}

function ScheduledAgentsShell(props: {
  repos: Repo[];
  runtimes: AgentRuntime[];
  workspaces: Workspace[];
  scheduledAgents: ScheduledAgent[];
}) {
  const [tab, setTab] = useState<Tab>("upcoming");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<ScheduledAgentDraft | null>(null);

  // "Upcoming" hides one-shots whose runAt has already passed — they can't
  // fire again, so they belong in History only. Recurring agents (enabled or
  // paused) and future/unset one-shots stay visible so the user can edit them.
  const upcoming = useMemo(() => props.scheduledAgents.filter(isUpcoming).sort(sortByNextRun), [props.scheduledAgents]);

  // Auto-select the first upcoming agent when there's none selected (or when
  // the previously-selected one is no longer upcoming). Keeps the editor
  // populated so the page never lands on a blank right pane.
  useEffect(() => {
    if (tab !== "upcoming") return;
    if (selectedId && upcoming.some((agent) => agent.id === selectedId)) return;
    setSelectedId(upcoming[0]?.id ?? null);
  }, [tab, selectedId, upcoming]);

  const selectedAgent = upcoming.find((agent) => agent.id === selectedId) ?? null;

  const openCreate = () => {
    setCreatePrefill(null);
    setCreateOpen(true);
  };
  const closeCreate = () => {
    setCreateOpen(false);
    setCreatePrefill(null);
  };
  const scheduleAgain = (agent: ScheduledAgent) => {
    setCreatePrefill(recurringDraftFromAgent(agent));
    setCreateOpen(true);
    // Stay on the History tab so the user keeps their context — they can
    // switch to Upcoming themselves once the new schedule lands.
  };

  return (
    <div className="sched-panel">
      <div className="sched-toolbar">
        <nav className="sched-tabs" aria-label="Scheduled agents view">
          <button
            type="button"
            className={`sched-tab ${tab === "upcoming" ? "active" : ""}`}
            onClick={() => setTab("upcoming")}
          >
            Upcoming
            <span className="sched-tab-count">{upcoming.length}</span>
          </button>
          <button
            type="button"
            className={`sched-tab ${tab === "history" ? "active" : ""}`}
            onClick={() => setTab("history")}
          >
            <HistoryIcon size={13} /> History
          </button>
        </nav>
        <Button type="button" onClick={openCreate}>
          <Plus size={14} /> New scheduled agent
        </Button>
      </div>

      {tab === "upcoming" ? (
        <UpcomingView
          upcoming={upcoming}
          selectedAgent={selectedAgent}
          onSelect={setSelectedId}
          onDeleted={() => setSelectedId(null)}
          onCreate={openCreate}
          repos={props.repos}
          runtimes={props.runtimes}
          workspaces={props.workspaces}
        />
      ) : (
        <ScheduledAgentsHistoryTimeline agents={props.scheduledAgents} onScheduleAgain={scheduleAgain} />
      )}

      {createOpen ? (
        <Modal
          title={createPrefill ? `Schedule "${createPrefill.name}" again` : "New scheduled agent"}
          onClose={closeCreate}
        >
          <ScheduledAgentForm
            mode="create"
            {...(createPrefill ? { initial: createPrefill } : {})}
            repos={props.repos}
            runtimes={props.runtimes}
            workspaces={props.workspaces}
            onSuccess={() => {
              closeCreate();
              setTab("upcoming");
            }}
          />
        </Modal>
      ) : null}
    </div>
  );
}

function UpcomingView(props: {
  upcoming: ScheduledAgent[];
  selectedAgent: ScheduledAgent | null;
  onSelect: (id: string) => void;
  onDeleted: () => void;
  onCreate: () => void;
  repos: Repo[];
  runtimes: AgentRuntime[];
  workspaces: Workspace[];
}) {
  if (!props.upcoming.length) {
    return (
      <UpcomingEmpty onCreate={props.onCreate}>
        No upcoming scheduled agents. Past one-shots live in the History tab.
      </UpcomingEmpty>
    );
  }
  return (
    <div className="sched-master-detail">
      <aside className="sched-list" aria-label="Scheduled agents">
        {props.upcoming.map((agent) => (
          <ScheduledAgentListItem
            key={agent.id}
            agent={agent}
            active={props.selectedAgent?.id === agent.id}
            onSelect={() => props.onSelect(agent.id)}
          />
        ))}
      </aside>
      <section className="sched-detail" aria-label="Scheduled agent editor">
        {props.selectedAgent ? (
          <ScheduledAgentEditor
            agent={props.selectedAgent}
            repos={props.repos}
            runtimes={props.runtimes}
            workspaces={props.workspaces}
            onDeleted={props.onDeleted}
          />
        ) : (
          <div className="empty">Pick a scheduled agent on the left to edit it, run it, or view its history.</div>
        )}
      </section>
    </div>
  );
}

function UpcomingEmpty(props: { onCreate: () => void; children: ReactNode }) {
  return (
    <div className="sched-empty">
      <p>{props.children}</p>
      <Button type="button" onClick={props.onCreate}>
        <Plus size={14} /> New scheduled agent
      </Button>
    </div>
  );
}

function ScheduledAgentListItem(props: { agent: ScheduledAgent; active: boolean; onSelect: () => void }) {
  const { agent } = props;
  const summary = scheduleSummary(agent);
  const nextRun = computeNextRun(agent);
  return (
    <button
      type="button"
      className={`sched-list-item ${props.active ? "active" : ""} ${agent.lastRunStatus}`}
      onClick={props.onSelect}
    >
      <div className="sched-list-item-title">
        <strong>{agent.name}</strong>
        {agent.enabled ? null : <span className="scheduled-agent-paused">paused</span>}
      </div>
      <small className="sched-list-item-schedule">{summary}</small>
      {nextRun ? <small className="sched-list-item-next">Next run: {nextRun.toLocaleString()}</small> : null}
    </button>
  );
}

function isUpcoming(agent: ScheduledAgent): boolean {
  if (agent.scheduleType === "recurring") return true;
  // One-shots: hide if runAt is in the past, regardless of whether it has
  // already fired. The History tab covers the "ran and done" case.
  if (!agent.runAt) return true;
  return new Date(agent.runAt).getTime() > Date.now();
}

function sortByNextRun(a: ScheduledAgent, b: ScheduledAgent): number {
  const an = computeNextRun(a)?.getTime() ?? Number.POSITIVE_INFINITY;
  const bn = computeNextRun(b)?.getTime() ?? Number.POSITIVE_INFINITY;
  if (an !== bn) return an - bn;
  return a.name.localeCompare(b.name);
}

function scheduleSummary(agent: ScheduledAgent): string {
  if (agent.scheduleType === "once") {
    return agent.runAt ? `Once at ${new Date(agent.runAt).toLocaleString()}` : "Once (no time set)";
  }
  if (agent.cron) return describeCronClient(agent.cron);
  return "Recurring (no cron configured)";
}

function computeNextRun(agent: ScheduledAgent): Date | null {
  if (!agent.enabled) return null;
  if (agent.scheduleType === "once") {
    if (!agent.runAt) return null;
    if (agent.lastRunStatus !== "never") return null;
    return new Date(agent.runAt);
  }
  if (!agent.cron) return null;
  return nextCronRunClient(agent.cron);
}
