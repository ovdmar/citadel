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
import { Plus, Save } from "lucide-react";
import { useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { FormField } from "./components/ui/form-field.js";
import { Input } from "./components/ui/input.js";
import { describeCronClient, nextCronRunClient } from "./cron-client.js";

// Reusable scheduled-agent form. Drives both the create modal and the
// per-agent editor in the master-detail view. Shape of the draft mirrors
// the API contract so submission is a thin field-by-field map.

export type Strategy = "new" | "existing";
export type OnceMode = "relative" | "absolute";

export type ScheduledAgentDraft = {
  name: string;
  description: string;
  scheduleType: ScheduledAgentScheduleType;
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
  runMode: ScheduledAgentRunMode;
  backgroundCwd: string;
  overlapPolicy: ScheduledAgentOverlapPolicy;
  enabled: boolean;
};

type CronPreset = { id: string; label: string; cron: string };
type RelativePreset = { id: string; label: string; minutes: number };

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

const EMPTY_DRAFT: ScheduledAgentDraft = {
  name: "",
  description: "",
  scheduleType: "recurring",
  cron: "0 9 * * *",
  onceMode: "relative",
  onceRelativeMinutes: 15,
  onceAbsoluteLocal: "",
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

function resolveRunAt(draft: ScheduledAgentDraft): { iso: string; date: Date } | null {
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

// Build a draft from an existing agent — used by the editor (mode="edit")
// and by "Schedule again" (mode="create" with a one-shot prefill that
// flips back to recurring).
export function draftFromAgent(agent: ScheduledAgent): ScheduledAgentDraft {
  return {
    name: agent.name,
    description: agent.description ?? "",
    scheduleType: agent.scheduleType,
    cron: agent.cron ?? "0 9 * * *",
    onceMode: "absolute",
    onceRelativeMinutes: 15,
    onceAbsoluteLocal: agent.runAt ? formatLocalDatetimeInput(new Date(agent.runAt)) : defaultAbsoluteLocal(),
    repoId: agent.repoId,
    runtimeId: agent.runtimeId,
    prompt: agent.prompt ?? "",
    workspaceStrategy: agent.workspaceStrategy,
    workspaceName: agent.workspaceName ?? "",
    baseBranch: agent.baseBranch ?? "",
    runMode: agent.runMode,
    backgroundCwd: agent.backgroundCwd ?? "",
    overlapPolicy: agent.overlapPolicy,
    enabled: agent.enabled,
  };
}

// Convert a past one-shot into a recurring-by-default draft. Keeps name +
// prompt + repo + runtime + run mode; flips schedule to recurring with a
// daily-9 default so the user can immediately pick a cron preset.
export function recurringDraftFromAgent(agent: ScheduledAgent): ScheduledAgentDraft {
  const base = draftFromAgent(agent);
  return {
    ...base,
    scheduleType: "recurring",
    cron: "0 9 * * *",
    name: agent.name,
    enabled: true,
  };
}

type FormProps = {
  mode: "create" | "edit";
  agentId?: string;
  initial?: ScheduledAgentDraft;
  repos: Repo[];
  runtimes: AgentRuntime[];
  workspaces: Workspace[];
  onSuccess?: () => void;
  // When true, hide the trailing "Add / Save" button so the caller (e.g. the
  // editor's sticky footer) can render its own action row.
  hideSubmit?: boolean;
};

export function ScheduledAgentForm(props: FormProps) {
  const initial = useMemo<ScheduledAgentDraft>(
    () => ({
      ...EMPTY_DRAFT,
      onceAbsoluteLocal: defaultAbsoluteLocal(),
      repoId: props.repos[0]?.id ?? "",
      runtimeId: props.runtimes[0]?.id ?? "",
      ...(props.initial ?? {}),
    }),
    [props.initial, props.repos, props.runtimes],
  );
  const [draft, setDraft] = useState<ScheduledAgentDraft>(initial);
  const [presetId, setPresetId] = useState<string>(() => {
    const matched = CRON_PRESETS.find((preset) => preset.cron === initial.cron);
    return matched ? matched.id : "custom";
  });
  const update = (patch: Partial<ScheduledAgentDraft>) => setDraft((current) => ({ ...current, ...patch }));

  const repoWorkspaces = useMemo(
    () => props.workspaces.filter((workspace) => workspace.repoId === draft.repoId),
    [props.workspaces, draft.repoId],
  );

  const resolvedRunAt = draft.scheduleType === "once" ? resolveRunAt(draft) : null;

  const buildBody = () => {
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
    if (draft.runMode === "workspace") {
      body.workspaceStrategy = draft.workspaceStrategy;
      body.workspaceName = draft.workspaceName.trim();
    }
    if (draft.scheduleType === "recurring") {
      body.cron = draft.cron.trim();
    } else if (resolvedRunAt) {
      body.runAt = resolvedRunAt.iso;
    }
    return body;
  };

  const submit = useMutation({
    mutationFn: () => {
      const body = buildBody();
      if (props.mode === "edit" && props.agentId) {
        return api(`/api/scheduled-agents/${props.agentId}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      return api("/api/scheduled-agents", { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onSuccess?.();
      if (props.mode === "create") {
        setDraft({
          ...EMPTY_DRAFT,
          onceAbsoluteLocal: defaultAbsoluteLocal(),
          repoId: props.repos[0]?.id ?? "",
          runtimeId: props.runtimes[0]?.id ?? "",
        });
      }
    },
  });

  const recurringValid = draft.scheduleType === "recurring" && draft.cron.trim().length > 0;
  const onceValid =
    draft.scheduleType === "once" && resolvedRunAt !== null && resolvedRunAt.date.getTime() > Date.now();
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

  const selectedRuntime = props.runtimes.find((entry) => entry.id === draft.runtimeId);
  const runtimeIsTui = selectedRuntime?.capabilities?.supportsTui ?? false;

  return (
    <form
      className="scheduled-agent-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !submit.isPending) submit.mutate();
      }}
    >
      <FormField label="Name" required className="scheduled-agent-field">
        <Input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
      </FormField>
      <label className="scheduled-agent-field">
        <span>Type</span>
        <select
          value={draft.scheduleType}
          onChange={(event) => update({ scheduleType: event.target.value as ScheduledAgentScheduleType })}
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
          onChange={(event) => update({ runMode: event.target.value as ScheduledAgentRunMode })}
          disabled={runtimeIsTui}
          title={
            runtimeIsTui
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
          onChange={(event) => update({ overlapPolicy: event.target.value as ScheduledAgentOverlapPolicy })}
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
      {props.hideSubmit ? null : (
        <div className="scheduled-agent-form-actions">
          <Button type="submit" disabled={!canSubmit || submit.isPending}>
            {props.mode === "edit" ? (
              <>
                <Save size={14} /> Save changes
              </>
            ) : (
              <>
                <Plus size={14} /> Add scheduled agent
              </>
            )}
          </Button>
          {submit.error ? <p className="form-error">{String(submit.error)}</p> : null}
        </div>
      )}
    </form>
  );
}
