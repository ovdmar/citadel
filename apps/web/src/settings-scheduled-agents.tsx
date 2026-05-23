import type { AgentRuntime, Repo, ScheduledAgent, ScheduledAgentScheduleType, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Play, Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

type Strategy = "new" | "existing";
type ScheduleType = ScheduledAgentScheduleType;
type OnceMode = "relative" | "absolute";

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
        workspaceStrategy: draft.workspaceStrategy,
        workspaceName: draft.workspaceName.trim(),
        baseBranch: draft.baseBranch.trim() || undefined,
        enabled: draft.enabled,
      };
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
  const canSubmit =
    draft.name.trim().length > 0 &&
    (recurringValid || onceValid) &&
    draft.repoId.length > 0 &&
    draft.runtimeId.length > 0 &&
    draft.workspaceName.trim().length > 0;

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
          {props.agent.workspaceStrategy === "new" ? "new workspace per run" : "reuse"} ({props.agent.workspaceName})
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

// Client-side mirror of the server cron parser + describeCron/nextCronRun.
// Kept here instead of importing @citadel/operations so the web bundle does
// not pull in the daemon dependency tree. If the cron grammar changes upstream
// these helpers need to follow.
type ClientCron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domWild: boolean;
  dowWild: boolean;
};

const CLIENT_CRON_BOUNDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
] as const;

function parseClientCron(spec: string): ClientCron | null {
  const parts = spec.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = parts.map((part, index) => {
    const bounds = CLIENT_CRON_BOUNDS[index];
    if (!bounds) return null;
    return parseClientCronField(part, bounds.min, bounds.max);
  });
  if (parsed.some((entry) => entry === null)) return null;
  const [minute, hour, dom, mon, dow] = parsed as Array<{ values: Set<number>; wild: boolean }>;
  if (!minute || !hour || !dom || !mon || !dow) return null;
  return {
    minute: minute.values,
    hour: hour.values,
    dom: dom.values,
    mon: mon.values,
    dow: dow.values,
    domWild: dom.wild,
    dowWild: dow.wild,
  };
}

function parseClientCronField(spec: string, min: number, max: number): { values: Set<number>; wild: boolean } | null {
  if (!spec.length) return null;
  let wild = false;
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    let body = part;
    let step = 1;
    const stepMatch = body.match(/^(.*)\/(\d+)$/);
    if (stepMatch?.[1] !== undefined && stepMatch[2] !== undefined) {
      body = stepMatch[1];
      step = Number.parseInt(stepMatch[2], 10);
      if (!Number.isFinite(step) || step <= 0) return null;
    }
    let lo: number;
    let hi: number;
    if (body === "*" || body === "") {
      lo = min;
      hi = max;
      if (spec === "*") wild = true;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = Number.parseInt(a ?? "", 10);
      hi = Number.parseInt(b ?? "", 10);
    } else {
      lo = Number.parseInt(body, 10);
      hi = lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) return null;
  return { values, wild };
}

function cronMatchesClient(expr: ClientCron, date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const mon = date.getMonth() + 1;
  const dow = date.getDay();
  if (!expr.minute.has(minute) || !expr.hour.has(hour) || !expr.mon.has(mon)) return false;
  if (expr.domWild && expr.dowWild) return true;
  if (expr.domWild) return expr.dow.has(dow);
  if (expr.dowWild) return expr.dom.has(dom);
  return expr.dom.has(dom) || expr.dow.has(dow);
}

function nextCronRunClient(spec: string, from: Date = new Date()): Date | null {
  const expr = parseClientCron(spec);
  if (!expr) return null;
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);
  const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() <= limit) {
    if (cronMatchesClient(expr, cursor)) return cursor;
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return null;
}

function describeCronClient(spec: string): string {
  const trimmed = spec.trim();
  const expr = parseClientCron(trimmed);
  if (!expr) return trimmed || "(empty)";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
  const onlyOne = (set: Set<number>) => (set.size === 1 ? (Array.from(set)[0] ?? null) : null);
  const time = (() => {
    const hour = onlyOne(expr.hour);
    const minute = onlyOne(expr.minute);
    if (hour === null || minute === null) return null;
    return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  })();
  if (expr.minute.size > 1 && expr.hour.size === 24) return "Every minute";
  if (expr.minute.size === 1 && expr.hour.size === 24) {
    const minute = onlyOne(expr.minute) ?? 0;
    return minute === 0 ? "Every hour" : `Every hour at :${minute.toString().padStart(2, "0")}`;
  }
  if (time && expr.domWild && expr.dowWild) return `Every day at ${time}`;
  if (time && expr.domWild && !expr.dowWild) {
    const list = Array.from(expr.dow)
      .sort((a, b) => a - b)
      .map((d) => days[d])
      .join(", ");
    return `Every ${list} at ${time}`;
  }
  if (time && !expr.domWild && expr.dowWild) {
    const list = Array.from(expr.dom)
      .sort((a, b) => a - b)
      .join(", ");
    return `On day ${list} of the month at ${time}`;
  }
  return trimmed;
}
