import type { AgentRuntime, Repo, ScheduledAgent } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

type Strategy = "new" | "existing";

type Draft = {
  name: string;
  description: string;
  cron: string;
  repoId: string;
  runtimeId: string;
  prompt: string;
  workspaceStrategy: Strategy;
  workspaceName: string;
  baseBranch: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  cron: "0 9 * * *",
  repoId: "",
  runtimeId: "",
  prompt: "",
  workspaceStrategy: "new",
  workspaceName: "",
  baseBranch: "",
  enabled: true,
};

export function ScheduledAgentsPanel(props: { state: StateResponse | undefined }) {
  const repos = props.state?.repos ?? [];
  const runtimes = props.state?.runtimes ?? [];
  const scheduledAgents = props.state?.scheduledAgents ?? [];

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
    <div className="settings-stack">
      <p className="settings-hint">
        Scheduled agents start an agent session on a cron schedule. They use the same MCPs and CLIs as interactive
        agents — if you want output to land in Slack, configure that inside the agent's tools, not here.
      </p>
      <CreateScheduledAgentCard repos={repos} runtimes={runtimes} />
      {scheduledAgents.length ? (
        <section className="settings-card">
          <header className="settings-card-header">
            <h3>Active schedules</h3>
            <p>Each row shows the cron, target workspace, and the latest run status.</p>
          </header>
          <div className="scheduled-agent-list">
            {scheduledAgents.map((agent) => (
              <ScheduledAgentRow key={agent.id} agent={agent} repos={repos} runtimes={runtimes} />
            ))}
          </div>
        </section>
      ) : (
        <div className="empty compact">No scheduled agents configured yet.</div>
      )}
    </div>
  );
}

function CreateScheduledAgentCard(props: { repos: Repo[]; runtimes: AgentRuntime[] }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY_DRAFT,
    repoId: props.repos[0]?.id ?? "",
    runtimeId: props.runtimes[0]?.id ?? "",
  }));
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const create = useMutation({
    mutationFn: () =>
      api<{ scheduledAgent: ScheduledAgent }>("/api/scheduled-agents", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description.trim() || undefined,
          cron: draft.cron.trim(),
          repoId: draft.repoId,
          runtimeId: draft.runtimeId,
          prompt: draft.prompt.trim() || undefined,
          workspaceStrategy: draft.workspaceStrategy,
          workspaceName: draft.workspaceName.trim(),
          baseBranch: draft.baseBranch.trim() || undefined,
          enabled: draft.enabled,
        }),
      }),
    onSuccess: () => {
      setDraft({ ...EMPTY_DRAFT, repoId: props.repos[0]?.id ?? "", runtimeId: props.runtimes[0]?.id ?? "" });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const canSubmit =
    draft.name.trim().length > 0 &&
    draft.cron.trim().length > 0 &&
    draft.repoId.length > 0 &&
    draft.runtimeId.length > 0 &&
    draft.workspaceName.trim().length > 0;

  return (
    <section className="settings-card">
      <header className="settings-card-header">
        <h3>New scheduled agent</h3>
        <p>Cron uses standard five-field syntax (minute hour day month weekday).</p>
      </header>
      <form
        className="scheduled-agent-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit && !create.isPending) create.mutate();
        }}
      >
        <label className="scheduled-agent-field">
          <span>Name</span>
          <input value={draft.name} onChange={(event) => update({ name: event.target.value })} required />
        </label>
        <label className="scheduled-agent-field">
          <span>Cron</span>
          <input
            value={draft.cron}
            onChange={(event) => update({ cron: event.target.value })}
            placeholder="0 9 * * *"
            required
          />
        </label>
        <label className="scheduled-agent-field">
          <span>Repository</span>
          <select value={draft.repoId} onChange={(event) => update({ repoId: event.target.value })}>
            {props.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <label className="scheduled-agent-field">
          <span>Agent runtime</span>
          <select value={draft.runtimeId} onChange={(event) => update({ runtimeId: event.target.value })}>
            {props.runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="scheduled-agent-field">
          <span>Workspace strategy</span>
          <select
            value={draft.workspaceStrategy}
            onChange={(event) => update({ workspaceStrategy: event.target.value as Strategy })}
          >
            <option value="new">New workspace per run</option>
            <option value="existing">Reuse one workspace</option>
          </select>
        </label>
        <label className="scheduled-agent-field">
          <span>Workspace name</span>
          <input
            value={draft.workspaceName}
            onChange={(event) => update({ workspaceName: event.target.value })}
            placeholder={
              draft.workspaceStrategy === "new" ? "name prefix (timestamp appended)" : "exact workspace name"
            }
            required
          />
        </label>
        <label className="scheduled-agent-field">
          <span>Base branch</span>
          <input
            value={draft.baseBranch}
            onChange={(event) => update({ baseBranch: event.target.value })}
            placeholder="defaults to repo default branch"
          />
        </label>
        <label className="scheduled-agent-field wide">
          <span>Description</span>
          <input value={draft.description} onChange={(event) => update({ description: event.target.value })} />
        </label>
        <label className="scheduled-agent-field wide">
          <span>Prompt</span>
          <textarea
            value={draft.prompt}
            onChange={(event) => update({ prompt: event.target.value })}
            rows={3}
            placeholder="Sent to the agent when each run starts. Leave blank to launch the runtime without a prompt."
          />
        </label>
        <label className="scheduled-agent-toggle">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          Enabled
        </label>
        <div className="scheduled-agent-form-actions">
          <Button type="submit" disabled={!canSubmit || create.isPending}>
            <Plus size={14} /> Add scheduled agent
          </Button>
          {create.error ? <p className="form-error">{String(create.error)}</p> : null}
        </div>
      </form>
    </section>
  );
}

function ScheduledAgentRow(props: { agent: ScheduledAgent; repos: Repo[]; runtimes: AgentRuntime[] }) {
  const repo = props.repos.find((candidate) => candidate.id === props.agent.repoId);
  const runtime = props.runtimes.find((candidate) => candidate.id === props.agent.runtimeId);
  const [confirming, setConfirming] = useState(false);

  const toggle = useMutation({
    mutationFn: () =>
      api(`/api/scheduled-agents/${props.agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !props.agent.enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const runNow = useMutation({
    mutationFn: () => api(`/api/scheduled-agents/${props.agent.id}/run`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/scheduled-agents/${props.agent.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  return (
    <div className={`scheduled-agent-row ${props.agent.lastRunStatus}`}>
      <div className="scheduled-agent-row-main">
        <div className="scheduled-agent-row-title">
          <strong>{props.agent.name}</strong>
          <span className="scheduled-agent-cron">{props.agent.cron}</span>
          {props.agent.enabled ? null : <span className="scheduled-agent-paused">paused</span>}
        </div>
        <small>
          {repo ? repo.name : props.agent.repoId} - {runtime ? runtime.displayName : props.agent.runtimeId} -{" "}
          {props.agent.workspaceStrategy === "new" ? "new workspace per run" : "reuse"} ({props.agent.workspaceName})
        </small>
        {props.agent.description ? <small>{props.agent.description}</small> : null}
        <small className={`scheduled-agent-status ${props.agent.lastRunStatus}`}>
          Last run: {formatLabel(props.agent.lastRunStatus)}
          {props.agent.lastRunAt ? ` - ${new Date(props.agent.lastRunAt).toLocaleString()}` : ""}
          {props.agent.lastRunMessage ? ` - ${props.agent.lastRunMessage}` : ""}
        </small>
      </div>
      <div className="scheduled-agent-row-actions">
        <Button type="button" variant="secondary" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
          <Play size={13} /> Run now
        </Button>
        <Button type="button" variant="ghost" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
          {props.agent.enabled ? "Pause" : "Resume"}
        </Button>
        <Button
          type="button"
          variant={confirming ? "default" : "ghost"}
          size="icon"
          onClick={() => (confirming ? remove.mutate() : setConfirming(true))}
          title={confirming ? "Confirm delete" : "Delete"}
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}
