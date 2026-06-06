import type { AgentRuntime } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlarmClock, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, queryClient } from "./api.js";

type RuntimeConfig = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
};

type FixCiAutomationConfig = {
  enabled: boolean;
  runtimeId: string;
  fallbackRuntimeId: string | null;
  idleThresholdMs: number;
  debounceMs: number;
  intervalMs: number;
};

type ConfigResponse = {
  config: {
    runtimes: RuntimeConfig[];
    automations?: { fixCi?: Partial<FixCiAutomationConfig> };
  };
};

type Draft = {
  enabled: boolean;
  runtimeId: string;
  fallbackRuntimeId: string;
  idleMinutes: number;
  debounceMinutes: number;
  intervalSeconds: number;
};

type RuntimeChoice = {
  id: string;
  label: string;
  command: string;
  health: AgentRuntime["health"];
  healthReason: string | null;
};

const DEFAULT_FIX_CI: FixCiAutomationConfig = {
  enabled: true,
  runtimeId: "claude-code",
  fallbackRuntimeId: "codex",
  idleThresholdMs: 300_000,
  debounceMs: 1_800_000,
  intervalMs: 60_000,
};

export function AutomationsPanel(props: { runtimes: AgentRuntime[]; scheduledAgentsCount: number }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  const current = useMemo(() => {
    return draftFromConfig(configQuery.data?.config.automations?.fixCi);
  }, [configQuery.data?.config.automations?.fixCi]);

  useEffect(() => {
    setDraft(current);
  }, [current]);

  const choices = useMemo(
    () => buildAutomationRuntimeChoices(configQuery.data?.config.runtimes ?? [], props.runtimes),
    [configQuery.data?.config.runtimes, props.runtimes],
  );
  const visibleChoices = useMemo(
    () => ensureSelectedChoices(choices, [draft?.runtimeId, draft?.fallbackRuntimeId]),
    [choices, draft?.runtimeId, draft?.fallbackRuntimeId],
  );

  const save = useMutation({
    mutationFn: (next: Draft) =>
      api<ConfigResponse>("/api/config", {
        method: "PUT",
        body: JSON.stringify({
          automations: {
            fixCi: configFromDraft(next),
          },
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  if (configQuery.isLoading || !draft) return <div className="set-card">Loading automations…</div>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(current);
  const primaryChoice = visibleChoices.find((choice) => choice.id === draft.runtimeId);
  const fallbackChoice = visibleChoices.find((choice) => choice.id === draft.fallbackRuntimeId);

  return (
    <>
      <div className="set-card set-section">
        <div className="set-section-head">
          <span className="set-section-eyebrow">Automatic CI repair</span>
          <span className={`set-pill ${draft.enabled ? "set-pill-ok" : "set-pill-mute"}`}>
            {draft.enabled ? "Enabled" : "Paused"}
          </span>
        </div>
        <div className="set-section-sub">
          Launches a fix-CI agent for a ready workspace when its PR checks are failing and no agent has been active
          recently.
        </div>

        <div className="set-form-grid">
          <label className="set-checkbox-row set-form-col-full">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            <span>Auto-launch fix-CI agents</span>
          </label>

          <label className="set-form-col">
            <span className="set-field-label">Primary agent</span>
            <select
              className="set-select"
              value={draft.runtimeId}
              onChange={(event) => setDraft({ ...draft, runtimeId: event.target.value })}
            >
              {visibleChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
            <RuntimeHealthLine choice={primaryChoice} />
          </label>

          <label className="set-form-col">
            <span className="set-field-label">Fallback agent</span>
            <select
              className="set-select"
              value={draft.fallbackRuntimeId}
              onChange={(event) => setDraft({ ...draft, fallbackRuntimeId: event.target.value })}
            >
              <option value="">None</option>
              {visibleChoices.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
            <RuntimeHealthLine choice={fallbackChoice} emptyLabel="No fallback configured." />
          </label>

          <NumberField
            label="Idle window"
            suffix="minutes"
            min={0}
            value={draft.idleMinutes}
            onChange={(idleMinutes) => setDraft({ ...draft, idleMinutes })}
          />
          <NumberField
            label="Retry debounce"
            suffix="minutes"
            min={0}
            value={draft.debounceMinutes}
            onChange={(debounceMinutes) => setDraft({ ...draft, debounceMinutes })}
          />
          <NumberField
            label="Check interval"
            suffix="seconds"
            min={1}
            value={draft.intervalSeconds}
            onChange={(intervalSeconds) => setDraft({ ...draft, intervalSeconds })}
          />
        </div>

        <div className="set-form-foot">
          <button
            type="button"
            className="set-btn set-btn-primary"
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || !dirty || !draft.runtimeId}
          >
            <Save size={13} /> Save automation
          </button>
          {save.error ? <span className="form-error">{String(save.error)}</span> : null}
        </div>
      </div>

      <div className="set-card set-section">
        <div className="set-section-head">
          <span className="set-section-eyebrow">Scheduled agents</span>
          <span className="set-section-count">{props.scheduledAgentsCount}</span>
        </div>
        <div className="set-section-sub">Cron and one-shot agent launches are managed from the scheduler.</div>
        <div className="set-form-foot" style={{ paddingTop: 0 }}>
          <Link to="/scheduled-agents" className="set-btn">
            <AlarmClock size={13} /> Open scheduled agents
          </Link>
        </div>
      </div>
    </>
  );
}

export function buildAutomationRuntimeChoices(
  configRuntimes: RuntimeConfig[],
  runtimeHealth: AgentRuntime[],
): RuntimeChoice[] {
  const healthById = new Map(runtimeHealth.map((runtime) => [runtime.id, runtime]));
  const source = configRuntimes.length
    ? configRuntimes
    : runtimeHealth.map((runtime) => ({
        id: runtime.id,
        displayName: runtime.displayName,
        command: runtime.command,
        args: runtime.args,
      }));
  const seen = new Set<string>();
  const choices: RuntimeChoice[] = [];
  for (const runtime of source) {
    if (runtime.id === "shell" || seen.has(runtime.id)) continue;
    seen.add(runtime.id);
    const health = healthById.get(runtime.id);
    choices.push({
      id: runtime.id,
      label: runtime.displayName,
      command: runtime.command,
      health: health?.health ?? "unknown",
      healthReason: health?.healthReason ?? null,
    });
  }
  return choices;
}

function draftFromConfig(config: Partial<FixCiAutomationConfig> | undefined): Draft {
  const fixCi = { ...DEFAULT_FIX_CI, ...config };
  return {
    enabled: fixCi.enabled,
    runtimeId: fixCi.runtimeId,
    fallbackRuntimeId: fixCi.fallbackRuntimeId ?? "",
    idleMinutes: msToRoundedUnit(fixCi.idleThresholdMs, 60_000),
    debounceMinutes: msToRoundedUnit(fixCi.debounceMs, 60_000),
    intervalSeconds: msToRoundedUnit(fixCi.intervalMs, 1000),
  };
}

function configFromDraft(draft: Draft): FixCiAutomationConfig {
  return {
    enabled: draft.enabled,
    runtimeId: draft.runtimeId,
    fallbackRuntimeId: draft.fallbackRuntimeId || null,
    idleThresholdMs: draft.idleMinutes * 60_000,
    debounceMs: draft.debounceMinutes * 60_000,
    intervalMs: draft.intervalSeconds * 1000,
  };
}

function msToRoundedUnit(ms: number, unit: number): number {
  return Math.max(0, Math.round(ms / unit));
}

function ensureSelectedChoices(choices: RuntimeChoice[], ids: Array<string | undefined>): RuntimeChoice[] {
  const seen = new Set(choices.map((choice) => choice.id));
  const missing = ids
    .filter((id): id is string => {
      if (!id) return false;
      return !seen.has(id);
    })
    .map((id) => ({
      id,
      label: `${id} (not configured)`,
      command: "",
      health: "unavailable" as const,
      healthReason: "Runtime is not configured.",
    }));
  return [...choices, ...missing];
}

function RuntimeHealthLine(props: { choice: RuntimeChoice | undefined; emptyLabel?: string }) {
  if (!props.choice) {
    return (
      <small className="set-page-help" style={{ marginTop: 6, display: "block" }}>
        {props.emptyLabel ?? "Runtime is not configured."}
      </small>
    );
  }
  const pillClass =
    props.choice.health === "healthy"
      ? "set-pill-ok"
      : props.choice.health === "degraded"
        ? "set-pill-warn"
        : props.choice.health === "unavailable"
          ? "set-pill-bad"
          : "set-pill-mute";
  return (
    <small className="set-page-help" style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
      <span className={`set-pill ${pillClass}`}>{props.choice.health}</span>
      <span className="set-mono">{props.choice.healthReason ?? props.choice.command}</span>
    </small>
  );
}

function NumberField(props: {
  label: string;
  suffix: string;
  min: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="set-form-col">
      <span className="set-field-label">{props.label}</span>
      <input
        className="set-input is-mono"
        type="number"
        min={props.min}
        value={props.value}
        onChange={(event) => {
          const value = event.currentTarget.valueAsNumber;
          props.onChange(Number.isFinite(value) ? Math.max(props.min, value) : props.min);
        }}
      />
      <small className="set-page-help" style={{ marginTop: 6, display: "block" }}>
        {props.suffix}
      </small>
    </label>
  );
}
