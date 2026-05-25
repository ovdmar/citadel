import type {
  AgentRuntime,
  Repo,
  ScheduledAgent,
  ScheduledAgentOverlapPolicy,
  ScheduledAgentRunMode,
  ScheduledAgentScheduleType,
  Workspace,
} from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { History, Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { type ApiError, api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { describeCronClient, nextCronRunClient } from "./cron-client.js";
import { formatLabel } from "./labels.js";
import { ScheduledAgentRunHistory } from "./scheduled-agent-run-history.js";

type Strategy = "new" | "existing";
type ScheduleType = ScheduledAgentScheduleType;
type OnceMode = "relative" | "absolute";
type RunMode = ScheduledAgentRunMode;
type OverlapPolicy = ScheduledAgentOverlapPolicy;

type Draft = {
  name: string;
  description: string;
  scheduleType: ScheduleType;
  cron: string;
  onceMode: OnceMode;
  onceRelativeMinutes: number;
  onceAbsoluteLocal: string;
  repoId: string;
  runtimeId: string;
  prompt: string;
  workspaceStrategy: Strategy;
  workspaceName: string;
  baseBranch: string;
  runMode: RunMode;
  backgroundCwd: string;
  overlapPolicy: OverlapPolicy;
  enabled: boolean;
};

type CronPreset = {
  id: string;
  label: string;
  cron: string;
};

type RelativePreset = {
  id: string;
  label: string;
  minutes: number;
};

// Human-friendly presets. "custom" keeps the raw input field visible so
// power users still have the full five-field syntax available.
const CRON_PRESETS: CronPreset[] = [
  { id: "every-5m", label: "Every 5 minutes", cron: "*/5 * * * *" },
  { id: "every-15m", label: "Every 15 minutes", cron: "*/15 * * * *" },
  { id: "every-30m", label: "Every 30 minutes", cron: "*/30 * * * *" },
  { id: "hourly", label: "Every hour, on the hour", cron: "0 * * * *" },
  { id: "every-2h", label: "Every 2 hours", cron: "0 */2 * * *" },
  { id: "every-6h", label: "Every 6 hours", cron: "0 */6 * * *" },
  { id: "daily-9", label: "Every day at 9:00", cron: "0 9 * * *" },
  { id: "weekdays-9", label: "Weekdays at 9:00", cron: "0 9 * * 1-5" },
  { id: "mondays-9", label: "Mondays at 9:00", cron: "0 9 * * 1" },
  { id: "monthly-1st", label: "First of the month at 9:00", cron: "0 9 1 * *" },
];

const RELATIVE_PRESETS: RelativePreset[] = [
  { id: "5m", label: "In 5 minutes", minutes: 5 },
  { id: "15m", label: "In 15 minutes", minutes: 15 },
  { id: "30m", label: "In 30 minutes", minutes: 30 },
  { id: "1h", label: "In 1 hour", minutes: 60 },
  { id: "3h", label: "In 3 hours", minutes: 180 },
  { id: "24h", label: "In 24 hours", minutes: 60 * 24 },
];

const EMPTY_DRAFT: Draft = {
  name: "",
  description: "",
  scheduleType: "recurring",
  cron: "0 9 * * *",
  onceMode: "relative",
  onceRelativeMinutes: 15,
  onceAbsoluteLocal: defaultAbsoluteLocal(),
  repoId: "",
  runtimeId: "",
  prompt: "",
  workspaceStrategy: "new",
  workspaceName: "",
  baseBranch: "",
  runMode: "workspace",
  backgroundCwd: "",
  overlapPolicy: "skip",
  enabled: true,
};

function defaultAbsoluteLocal(): string {
  const target = new Date(Date.now() + 60 * 60 * 1000);
  target.setSeconds(0, 0);
  return formatLocalDatetimeInput(target);
}

function formatLocalDatetimeInput(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resolveRunAt(draft: Draft): { iso: string; date: Date } | null {
  if (draft.onceMode === "relative") {
    const minutes = Number(draft.onceRelativeMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const date = new Date(Date.now() + minutes * 60 * 1000);
    return { iso: date.toISOString(), date };
  }
  if (!draft.onceAbsoluteLocal) return null;
  const date = new Date(draft.onceAbsoluteLocal);
  if (Number.isNaN(date.getTime())) return null;
  return { iso: date.toISOString(), date };
}

export function ScheduledAgentsPanel(props: { state: StateResponse | undefined }) {
  const repos = props.state?.repos ?? [];
  const runtimes = props.state?.runtimes ?? [];
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
    <div className="settings-stack">
      <p className="settings-hint">
        Scheduled agents start an agent session on a cron schedule. They use the same MCPs and CLIs as interactive
        agents — if you want output to land in Slack, configure that inside the agent's tools, not here.
      </p>
      <CreateScheduledAgentCard repos={repos} runtimes={runtimes} workspaces={workspaces} />
      {scheduledAgents.length ? (
        <section className="settings-card">
          <header className="settings-card-header">
            <h3>Active schedules</h3>
            <p>Each row shows the cron, target workspace, and the latest run status.</p>
          </header>
          <div className="scheduled-agent-list">
            {scheduledAgents.map((agent) => (
              <ScheduledAgentRow
                key={agent.id}
                agent={agent}
                repos={repos}
                runtimes={runtimes}
                workspaces={workspaces}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="empty compact">No scheduled agents configured yet.</div>
      )}
    </div>
  );
}

function CreateScheduledAgentCard(props: { repos: Repo[]; runtimes: AgentRuntime[]; workspaces: Workspace[] }) {
  const [draft, setDraft] = useState<Draft>(() => ({
    ...EMPTY_DRAFT,
    repoId: props.repos[0]?.id ?? "",
    runtimeId: props.runtimes[0]?.id ?? "",
  }));
  const [presetId, setPresetId] = useState<string>("daily-9");
  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));

  const repoWorkspaces = useMemo(
    () => props.workspaces.filter((workspace) => workspace.repoId === draft.repoId),
    [props.workspaces, draft.repoId],
  );

  const resolvedRunAt = draft.scheduleType === "once" ? resolveRunAt(draft) : null;

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        name: draft.name.trim(),
        description: draft.description.trim() || undefined,
        scheduleType: draft.scheduleType,
        repoId: draft.repoId,
        runtimeId: draft.runtimeId,
        prompt: draft.prompt.trim() || undefined,
        baseBranch: draft.baseBranch.trim() || undefined,
        runMode: draft.runMode,
        backgroundCwd:
          draft.runMode === "background" && draft.backgroundCwd.trim() ? draft.backgroundCwd.trim() : undefined,
        overlapPolicy: draft.overlapPolicy,
        enabled: draft.enabled,
      };
      // workspaceStrategy + workspaceName are only sent for workspace runMode;
      // the contract's superRefine enforces that they're absent (or undefined)
      // for background runs rather than the UI fabricating a placeholder.
      if (draft.runMode === "workspace") {
        body.workspaceStrategy = draft.workspaceStrategy;
        body.workspaceName = draft.workspaceName.trim();
      }
      if (draft.scheduleType === "recurring") {
        body.cron = draft.cron.trim();
      } else if (resolvedRunAt) {
        body.runAt = resolvedRunAt.iso;
      }
      return api<{ scheduledAgent: ScheduledAgent }>("/api/scheduled-agents", {
        method: "POST",
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => {
      setDraft({
        ...EMPTY_DRAFT,
        onceAbsoluteLocal: defaultAbsoluteLocal(),
        repoId: props.repos[0]?.id ?? "",
        runtimeId: props.runtimes[0]?.id ?? "",
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const recurringValid = draft.scheduleType === "recurring" && draft.cron.trim().length > 0;
  const onceValid =
    draft.scheduleType === "once" && resolvedRunAt !== null && resolvedRunAt.date.getTime() > Date.now();
  // workspaceName is only required for runMode='workspace'; background uses
  // backgroundCwd (or the repo's rootPath by default) and ignores it.
  const workspaceFieldsValid = draft.runMode === "background" ? true : draft.workspaceName.trim().length > 0;
  const canSubmit =
    draft.name.trim().length > 0 &&
    (recurringValid || onceValid) &&
    draft.repoId.length > 0 &&
    draft.runtimeId.length > 0 &&
    workspaceFieldsValid;

  const cronSummary = describeCronClient(draft.cron);
  const nextRun = draft.scheduleType === "recurring" ? nextCronRunClient(draft.cron) : (resolvedRunAt?.date ?? null);

  const onPresetChange = (next: string) => {
    setPresetId(next);
    const preset = CRON_PRESETS.find((entry) => entry.id === next);
    if (preset) update({ cron: preset.cron });
  };

  return (
    <section className="settings-card">
      <header className="settings-card-header">
        <h3>New scheduled agent</h3>
        <p>Pick a recurring preset, write a cron expression, or schedule a one-shot run.</p>
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
          <span>Type</span>
          <select
            value={draft.scheduleType}
            onChange={(event) => update({ scheduleType: event.target.value as ScheduleType })}
          >
            <option value="recurring">Recurring</option>
            <option value="once">One-shot</option>
          </select>
        </label>
        {draft.scheduleType === "recurring" ? (
          <>
            <label className="scheduled-agent-field">
              <span>Schedule</span>
              <select value={presetId} onChange={(event) => onPresetChange(event.target.value)}>
                {CRON_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
                <option value="custom">Custom (cron expression)</option>
              </select>
            </label>
            {presetId === "custom" ? (
              <label className="scheduled-agent-field">
                <span>Cron</span>
                <input
                  value={draft.cron}
                  onChange={(event) => update({ cron: event.target.value })}
                  placeholder="0 9 * * *"
                  required
                />
              </label>
            ) : null}
          </>
        ) : (
          <>
            <label className="scheduled-agent-field">
              <span>When</span>
              <select value={draft.onceMode} onChange={(event) => update({ onceMode: event.target.value as OnceMode })}>
                <option value="relative">Relative (in N minutes/hours)</option>
                <option value="absolute">Absolute (pick a date/time)</option>
              </select>
            </label>
            {draft.onceMode === "relative" ? (
              <label className="scheduled-agent-field">
                <span>In</span>
                <select
                  value={String(draft.onceRelativeMinutes)}
                  onChange={(event) => update({ onceRelativeMinutes: Number(event.target.value) })}
                >
                  {RELATIVE_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.minutes}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="scheduled-agent-field">
                <span>At</span>
                <input
                  type="datetime-local"
                  value={draft.onceAbsoluteLocal}
                  onChange={(event) => update({ onceAbsoluteLocal: event.target.value })}
                  required
                />
              </label>
            )}
          </>
        )}
        <div className="scheduled-agent-field wide scheduled-agent-cron-summary" aria-live="polite">
          <span>Fires</span>
          <div>
            {draft.scheduleType === "recurring" ? (
              <>
                <strong>{cronSummary}</strong>
                {nextRun ? (
                  <small>Next run: {nextRun.toLocaleString()}</small>
                ) : (
                  <small className="form-error">Cron expression is not valid yet.</small>
                )}
              </>
            ) : (
              <>
                <strong>One-shot run</strong>
                {nextRun ? (
                  onceValid ? (
                    <small>At: {nextRun.toLocaleString()}</small>
                  ) : (
                    <small className="form-error">That time is already in the past.</small>
                  )
                ) : (
                  <small className="form-error">Pick a future time.</small>
                )}
              </>
            )}
          </div>
        </div>
        <label className="scheduled-agent-field">
          <span>Repository</span>
          <select value={draft.repoId} onChange={(event) => update({ repoId: event.target.value, workspaceName: "" })}>
            {props.repos.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.name}
              </option>
            ))}
          </select>
        </label>
        <label className="scheduled-agent-field">
          <span>Agent runtime</span>
          <select
            value={draft.runtimeId}
            onChange={(event) => {
              const next = event.target.value;
              const runtime = props.runtimes.find((entry) => entry.id === next);
              // If the picked runtime is TUI-only and we're on background mode,
              // snap back to workspace because background pipe-pane log would be
              // unreadable ANSI noise for TUI runtimes.
              const supportsTui = runtime?.capabilities?.supportsTui ?? false;
              if (supportsTui && draft.runMode === "background") {
                update({ runtimeId: next, runMode: "workspace" });
              } else {
                update({ runtimeId: next });
              }
            }}
          >
            {props.runtimes.map((runtime) => (
              <option key={runtime.id} value={runtime.id}>
                {runtime.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="scheduled-agent-field">
          <span>Run mode</span>
          <select
            value={draft.runMode}
            onChange={(event) => update({ runMode: event.target.value as RunMode })}
            disabled={!!props.runtimes.find((r) => r.id === draft.runtimeId)?.capabilities?.supportsTui}
            title={
              props.runtimes.find((r) => r.id === draft.runtimeId)?.capabilities?.supportsTui
                ? "This runtime is a TUI — background mode would produce an unreadable log file. Use Workspace."
                : undefined
            }
          >
            <option value="workspace">Workspace (create or reuse a worktree per run)</option>
            <option value="background">Background (tmux pane in a configurable cwd, no workspace)</option>
          </select>
        </label>
        {draft.runMode === "background" ? (
          <>
            <label className="scheduled-agent-field">
              <span>Background cwd</span>
              <input
                value={draft.backgroundCwd}
                onChange={(event) => update({ backgroundCwd: event.target.value })}
                placeholder="defaults to the repo's rootPath"
              />
            </label>
            <p className="settings-hint">
              Background runs are intended for non-TUI scripts ({"bash -lc 'date'"}, curl + jq, gh api). For Claude Code
              or Codex, use Workspace — those runtimes emit ANSI that would garble the per-run log file.
            </p>
          </>
        ) : (
          <>
            <label className="scheduled-agent-field">
              <span>Workspace strategy</span>
              <select
                value={draft.workspaceStrategy}
                onChange={(event) => update({ workspaceStrategy: event.target.value as Strategy, workspaceName: "" })}
              >
                <option value="new">New workspace per run</option>
                <option value="existing">Reuse one workspace</option>
              </select>
            </label>
            {/* For "reuse" we pick from existing workspaces (avoids typos / orphaned
                schedules pointing at a workspace that does not exist). For "new" we
                keep the freeform field — it becomes the per-run name prefix. */}
            {draft.workspaceStrategy === "existing" ? (
              <label className="scheduled-agent-field">
                <span>Existing workspace</span>
                <select
                  value={draft.workspaceName}
                  onChange={(event) => update({ workspaceName: event.target.value })}
                  required
                >
                  <option value="">Select a workspace…</option>
                  {repoWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.name}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="scheduled-agent-field">
                <span>Workspace name prefix</span>
                <input
                  value={draft.workspaceName}
                  onChange={(event) => update({ workspaceName: event.target.value })}
                  placeholder="name prefix (timestamp appended each run)"
                  required
                />
              </label>
            )}
            <label className="scheduled-agent-field">
              <span>Base branch</span>
              <input
                value={draft.baseBranch}
                onChange={(event) => update({ baseBranch: event.target.value })}
                placeholder="defaults to repo default branch"
              />
            </label>
          </>
        )}
        <label className="scheduled-agent-field">
          <span>When already running</span>
          <select
            value={draft.overlapPolicy}
            onChange={(event) => update({ overlapPolicy: event.target.value as OverlapPolicy })}
          >
            <option value="skip">Skip this fire</option>
            <option value="queue">Queue and run after (max 10 waiting)</option>
          </select>
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

function ScheduledAgentRow(props: {
  agent: ScheduledAgent;
  repos: Repo[];
  runtimes: AgentRuntime[];
  workspaces: Workspace[];
}) {
  const repo = props.repos.find((candidate) => candidate.id === props.agent.repoId);
  const runtime = props.runtimes.find((candidate) => candidate.id === props.agent.runtimeId);
  const [confirming, setConfirming] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const toggle = useMutation({
    mutationFn: () =>
      api(`/api/scheduled-agents/${props.agent.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !props.agent.enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  // POST /run has four outcomes mapped from runner.runNow:
  //   202 + { runId, status: "succeeded"|"failed", ... } — fired synchronously
  //   202 + { queued: true, runId, queuePosition }       — enqueued (queue policy)
  //   409 + { error: "run_already_in_progress" }         — skip policy + busy
  //   429 + { error: "queue_full", limit }                — queue full
  // The api() helper throws on non-2xx, so the 409/429 paths land in onError.
  type RunNowResponse =
    | { runId: string; status: "succeeded" | "failed"; message?: string }
    | { queued: true; runId: string; queuePosition: number };
  const runNow = useMutation<RunNowResponse, ApiError>({
    mutationFn: () => api<RunNowResponse>(`/api/scheduled-agents/${props.agent.id}/run`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  // Inline feedback string derived from the last attempt; auto-clears after 6s.
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

  const remove = useMutation({
    mutationFn: () => api(`/api/scheduled-agents/${props.agent.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const isOnce = props.agent.scheduleType === "once";
  let summary: string;
  let nextRun: Date | null = null;
  if (isOnce) {
    summary = props.agent.runAt ? `Once at ${new Date(props.agent.runAt).toLocaleString()}` : "Once (no time set)";
    if (props.agent.enabled && props.agent.runAt && props.agent.lastRunStatus === "never") {
      nextRun = new Date(props.agent.runAt);
    }
  } else if (props.agent.cron) {
    summary = describeCronClient(props.agent.cron);
    if (props.agent.enabled) nextRun = nextCronRunClient(props.agent.cron);
  } else {
    // Recurring agent with no cron is a data invariant violation — surface it
    // instead of silently coercing to "" and parsing nothing.
    summary = "Recurring (no cron configured)";
  }

  return (
    <div className={`scheduled-agent-row ${props.agent.lastRunStatus}`}>
      <div className="scheduled-agent-row-main">
        <div className="scheduled-agent-row-title">
          <strong>{props.agent.name}</strong>
          <span
            className="scheduled-agent-cron"
            title={
              isOnce ? `One-shot: ${props.agent.runAt ?? "unscheduled"}` : `Cron: ${props.agent.cron ?? "(missing)"}`
            }
          >
            {summary}
          </span>
          {props.agent.enabled ? null : <span className="scheduled-agent-paused">paused</span>}
        </div>
        <small>
          {repo ? repo.name : props.agent.repoId} - {runtime ? runtime.displayName : props.agent.runtimeId} -{" "}
          {props.agent.runMode === "background"
            ? `background in ${props.agent.backgroundCwd ?? repo?.rootPath ?? "<repo root>"}`
            : `${props.agent.workspaceStrategy === "new" ? "new workspace per run" : "reuse"} (${props.agent.workspaceName})`}
          {props.agent.overlapPolicy === "queue" ? " · queues up to 10" : " · skips overlaps"}
        </small>
        {nextRun ? <small>Next run: {nextRun.toLocaleString()}</small> : null}
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
        {runNowFeedback ? <span className="scheduled-agent-run-feedback">{runNowFeedback}</span> : null}
        <Button type="button" variant="ghost" onClick={() => setHistoryOpen((v) => !v)} title="View run history">
          <History size={13} /> History
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
      {historyOpen ? <ScheduledAgentRunHistory agentId={props.agent.id} /> : null}
    </div>
  );
}
