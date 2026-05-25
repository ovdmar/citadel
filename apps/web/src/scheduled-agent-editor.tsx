import type { AgentRuntime, Repo, ScheduledAgent, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { type ApiError, api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { describeCronClient, nextCronRunClient } from "./cron-client.js";
import { formatLabel } from "./labels.js";
import { DeleteScheduledAgentDialog } from "./scheduled-agent-delete-dialog.js";
import { ScheduledAgentForm, draftFromAgent } from "./scheduled-agent-form.js";
import { ScheduledAgentRunHistory } from "./scheduled-agent-run-history.js";

// Right-pane editor: header summary, edit form, run-now controls, pause/
// resume, delete (with confirmation), and the per-agent history drawer
// (always visible — the user is already deep inside one agent's detail).
export function ScheduledAgentEditor(props: {
  agent: ScheduledAgent;
  repos: Repo[];
  runtimes: AgentRuntime[];
  workspaces: Workspace[];
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const repo = props.repos.find((candidate) => candidate.id === props.agent.repoId);
  const runtime = props.runtimes.find((candidate) => candidate.id === props.agent.runtimeId);

  const toggle = useMutation({
    mutationFn: () =>
      api(`/api/scheduled-agents/${props.agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !props.agent.enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  type RunNowResponse =
    | { runId: string; status: "succeeded" | "failed"; message?: string }
    | { queued: true; runId: string; queuePosition: number };
  const runNow = useMutation<RunNowResponse, ApiError>({
    mutationFn: () => api<RunNowResponse>(`/api/scheduled-agents/${props.agent.id}/run`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const runNowFeedback = (() => {
    if (runNow.isPending) return null;
    if (runNow.error) {
      if (runNow.error.message === "run_already_in_progress") return "Already running — skip policy.";
      if (runNow.error.message === "queue_full") return "Queue full (max 10).";
      return `Failed: ${runNow.error.message}`;
    }
    if (runNow.data) {
      if ("queued" in runNow.data) return `Queued (position ${runNow.data.queuePosition}).`;
      return runNow.data.status === "succeeded" ? "Started." : `Failed: ${runNow.data.message ?? "see history"}.`;
    }
    return null;
  })();

  const summary = scheduleSummary(props.agent);
  const nextRun = computeNextRun(props.agent);

  return (
    <div className="sched-editor">
      <header className="sched-editor-header">
        <div className="sched-editor-title-row">
          <h2 className="sched-editor-title">{props.agent.name}</h2>
          {props.agent.enabled ? null : <span className="scheduled-agent-paused">paused</span>}
        </div>
        <div className="sched-editor-meta">
          <span>{summary}</span>
          <span>·</span>
          <span>{repo ? repo.name : props.agent.repoId}</span>
          <span>·</span>
          <span>{runtime ? runtime.displayName : props.agent.runtimeId}</span>
          {nextRun ? (
            <>
              <span>·</span>
              <span>Next run: {nextRun.toLocaleString()}</span>
            </>
          ) : null}
        </div>
        <div className="sched-editor-actions">
          <Button type="button" onClick={() => runNow.mutate()} disabled={runNow.isPending}>
            <Play size={14} /> Run now
          </Button>
          {runNowFeedback ? <span className="scheduled-agent-run-feedback">{runNowFeedback}</span> : null}
          <Button type="button" variant="secondary" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
            {props.agent.enabled ? (
              <>
                <Pause size={13} /> Pause
              </>
            ) : (
              <>
                <Play size={13} /> Resume
              </>
            )}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setDeleting(true)} title="Delete scheduled agent">
            <Trash2 size={13} /> Delete
          </Button>
        </div>
        <small className={`scheduled-agent-status ${props.agent.lastRunStatus}`}>
          Last run: {formatLabel(props.agent.lastRunStatus)}
          {props.agent.lastRunAt ? ` · ${new Date(props.agent.lastRunAt).toLocaleString()}` : ""}
          {props.agent.lastRunMessage ? ` · ${props.agent.lastRunMessage}` : ""}
        </small>
      </header>

      <section className="sched-editor-section">
        <header className="settings-card-header">
          <h3>Edit configuration</h3>
          <p>Changes save individually. Toggling Enabled here mirrors the Pause/Resume button above.</p>
        </header>
        <ScheduledAgentForm
          mode="edit"
          agentId={props.agent.id}
          initial={draftFromAgent(props.agent)}
          repos={props.repos}
          runtimes={props.runtimes}
          workspaces={props.workspaces}
        />
      </section>

      <section className="sched-editor-section">
        <header className="settings-card-header">
          <h3>Run history</h3>
          <p>Every fire — queued, running, succeeded, failed. Updates live as runs progress.</p>
        </header>
        <ScheduledAgentRunHistory agentId={props.agent.id} />
      </section>

      {deleting ? (
        <DeleteScheduledAgentDialog
          agent={props.agent}
          onClose={() => setDeleting(false)}
          onDeleted={props.onDeleted}
        />
      ) : null}
    </div>
  );
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
