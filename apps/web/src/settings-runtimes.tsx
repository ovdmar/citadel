import type { AgentRuntime, RuntimeUsageSummary } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";
import { categoryKey, formatLocalReset } from "./lib/usage-format.js";

type RuntimeConfig = {
  id: string;
  displayName: string;
  command: string;
  args: string[];
  promptArg?: string;
  resumeArg?: string;
  supportsResume?: boolean;
  supportsPrompt?: boolean;
  supportsModelSelection?: boolean;
  showUsageInTopBar?: boolean;
  topBarCategoryKey?: string;
};

type ConfigResponse = { config: { runtimes: RuntimeConfig[] } };

const PLATFORM_AGENTS: Record<string, { label: string; blurb: string; kind: "agent" | "terminal" }> = {
  "claude-code": {
    label: "Claude Code",
    blurb: "Anthropic's official CLI. Primary long-running coding agent.",
    kind: "agent",
  },
  "cursor-agent": {
    label: "Cursor Agent",
    blurb: "Cursor's headless agent runtime. Prompt-driven and non-interactive friendly.",
    kind: "agent",
  },
  pi: {
    label: "Pi",
    blurb: "Inflection Pi runtime. Prompt-driven conversational agent.",
    kind: "agent",
  },
  shell: {
    label: "Plain Terminal",
    blurb: "Built-in shell terminal. Useful when you need a TTY but should not count as agent work.",
    kind: "terminal",
  },
};

const PLATFORM_IDS = Object.keys(PLATFORM_AGENTS);

export function AgentsPanel(props: { runtimes: AgentRuntime[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const [drafts, setDrafts] = useState<RuntimeConfig[]>([]);
  const [newAgent, setNewAgent] = useState<RuntimeConfig>({
    id: "",
    displayName: "",
    command: "",
    args: [],
    supportsPrompt: true,
  });

  useEffect(() => {
    if (configQuery.data?.config.runtimes) setDrafts(configQuery.data.config.runtimes);
  }, [configQuery.data?.config.runtimes]);

  const save = useMutation({
    mutationFn: (runtimes: RuntimeConfig[]) =>
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ runtimes }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const platform = props.runtimes.filter((runtime) => PLATFORM_IDS.includes(runtime.id));
  const custom = props.runtimes.filter((runtime) => !PLATFORM_IDS.includes(runtime.id));
  const missingPlatform = PLATFORM_IDS.filter((id) => !platform.some((entry) => entry.id === id));

  const updateDraft = (id: string, patch: Partial<RuntimeConfig>) => {
    setDrafts((current) => current.map((runtime) => (runtime.id === id ? { ...runtime, ...patch } : runtime)));
  };

  // Apply a patch and immediately persist — used by the in-row "Show in top
  // bar" toggle and the category-pin radio so the change reaches the cockpit
  // without a separate Save click. We compute `next` synchronously and pass
  // it to both setDrafts and save.mutate so the mutation never sees stale
  // state (queueMicrotask would still capture the pre-setState `drafts`).
  const updateDraftAndPersist = (id: string, patch: Partial<RuntimeConfig>) => {
    const next = drafts.map((runtime) => (runtime.id === id ? { ...runtime, ...patch } : runtime));
    setDrafts(next);
    save.mutate(next);
  };

  const removeDraft = (id: string) => {
    setDrafts((current) => current.filter((runtime) => runtime.id !== id));
  };

  const addNewAgent = () => {
    const id = newAgent.id.trim();
    const displayName = newAgent.displayName.trim();
    const command = newAgent.command.trim();
    if (!id || !displayName || !command || drafts.some((runtime) => runtime.id === id)) return;
    setDrafts((current) => [
      ...current,
      {
        ...newAgent,
        id,
        displayName,
        command,
        args: newAgent.args,
        supportsPrompt: true,
      },
    ]);
    setNewAgent({ id: "", displayName: "", command: "", args: [], supportsPrompt: true });
  };

  return (
    <div className="settings-stack">
      <p className="settings-hint">
        Agents are the CLIs Citadel can launch in a workspace. Platform agents are first-class presets; custom agents
        can be added here without going through Advanced settings.
      </p>
      <section className="settings-card">
        <header className="settings-card-header">
          <h3>Platform agents</h3>
          <p>Citadel knows these names and shows their health from PATH/auth checks.</p>
        </header>
        <div className="runtime-grid">
          {platform.map((runtime) => (
            <RuntimeRow
              key={runtime.id}
              runtime={runtime}
              platform
              draft={drafts.find((entry) => entry.id === runtime.id)}
              onToggleTopBar={(next) => updateDraftAndPersist(runtime.id, { showUsageInTopBar: next })}
              onPickTopBarCategory={(key) => updateDraftAndPersist(runtime.id, { topBarCategoryKey: key })}
              saving={save.isPending}
            />
          ))}
          {missingPlatform.map((id) => {
            const meta = PLATFORM_AGENTS[id];
            if (!meta) return null;
            return (
              <div key={id} className="runtime-card missing">
                <header>
                  <strong>{meta.label}</strong>
                  <span className={`runtime-kind ${meta.kind}`}>{formatLabel(meta.kind)}</span>
                </header>
                <p>{meta.blurb}</p>
                <small>Not registered. Add it below with the expected command to enable it.</small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="settings-card">
        <header className="settings-card-header">
          <h3>Agent config</h3>
          <p>Edit commands and add custom agents directly here. Plain Terminal stays available as a terminal option.</p>
        </header>
        {configQuery.isLoading ? <div className="empty compact">Loading agents...</div> : null}
        <div className="agent-config-list">
          {drafts.map((runtime) => (
            <div key={runtime.id} className="agent-config-row">
              <input
                value={runtime.displayName}
                onChange={(event) => updateDraft(runtime.id, { displayName: event.target.value })}
                aria-label={`Display name for ${runtime.id}`}
              />
              <input
                value={runtime.command}
                onChange={(event) => updateDraft(runtime.id, { command: event.target.value })}
                aria-label={`Command for ${runtime.id}`}
              />
              <input
                value={runtime.args.join(" ")}
                onChange={(event) =>
                  updateDraft(runtime.id, {
                    args: event.target.value
                      .split(" ")
                      .map((part) => part.trim())
                      .filter(Boolean),
                  })
                }
                aria-label={`Arguments for ${runtime.id}`}
                placeholder="args"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeDraft(runtime.id)}
                title="Remove agent"
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
          <div className="agent-config-row new">
            <input
              value={newAgent.id}
              onChange={(event) =>
                setNewAgent((current) => ({
                  ...current,
                  id: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
                }))
              }
              placeholder="agent-id"
              aria-label="New agent id"
            />
            <input
              value={newAgent.displayName}
              onChange={(event) => setNewAgent((current) => ({ ...current, displayName: event.target.value }))}
              placeholder="Display name"
              aria-label="New agent display name"
            />
            <input
              value={newAgent.command}
              onChange={(event) => setNewAgent((current) => ({ ...current, command: event.target.value }))}
              placeholder="command"
              aria-label="New agent command"
            />
            <Button type="button" variant="secondary" onClick={addNewAgent} title="Add custom agent">
              <Plus size={13} /> Add
            </Button>
          </div>
        </div>
        <div className="settings-actions">
          <Button type="button" onClick={() => save.mutate(drafts)} disabled={save.isPending || !drafts.length}>
            <Save size={14} /> Save agents
          </Button>
          {save.error ? <p className="form-error">{String(save.error)}</p> : null}
        </div>
      </section>
      {custom.length ? (
        <section className="settings-card">
          <header className="settings-card-header">
            <h3>Custom agent health</h3>
            <p>Health for non-platform commands currently registered in config.</p>
          </header>
          <div className="runtime-grid">
            {custom.map((runtime) => (
              <RuntimeRow
                key={runtime.id}
                runtime={runtime}
                platform={false}
                draft={drafts.find((entry) => entry.id === runtime.id)}
                onToggleTopBar={(next) => updateDraftAndPersist(runtime.id, { showUsageInTopBar: next })}
                onPickTopBarCategory={(key) => updateDraftAndPersist(runtime.id, { topBarCategoryKey: key })}
                saving={save.isPending}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export const RuntimesPanel = AgentsPanel;

function RuntimeRow(props: {
  runtime: AgentRuntime;
  platform: boolean;
  draft: RuntimeConfig | undefined;
  onToggleTopBar: (next: boolean) => void;
  onPickTopBarCategory: (key: string) => void;
  saving: boolean;
}) {
  const platformMeta = props.platform ? PLATFORM_AGENTS[props.runtime.id] : undefined;
  const kindLabel = platformMeta?.kind ?? (props.runtime.capabilities.supportsPrompt ? "agent" : "terminal");
  const healthy = props.runtime.health === "healthy";
  return (
    <div className={`runtime-card ${props.runtime.health}`}>
      <header>
        <strong>{platformMeta?.label ?? props.runtime.displayName}</strong>
        <span className={`runtime-kind ${kindLabel}`}>{formatLabel(kindLabel)}</span>
        {props.platform ? (
          <span className="runtime-badge platform">Built-in</span>
        ) : (
          <span className="runtime-badge custom">Custom</span>
        )}
      </header>
      {platformMeta ? <p>{platformMeta.blurb}</p> : null}
      <div className={`runtime-health ${props.runtime.health}`}>
        <span>{formatLabel(props.runtime.health)}</span>
        {props.runtime.healthReason ? <small>{props.runtime.healthReason}</small> : null}
      </div>
      <code className="runtime-command">{[props.runtime.command, ...props.runtime.args].join(" ").trim()}</code>
      {props.runtime.capabilities.supportsUsage && healthy ? (
        <RuntimeUsagePanel
          runtimeId={props.runtime.id}
          showInTopBar={props.draft?.showUsageInTopBar ?? false}
          topBarCategoryKey={props.draft?.topBarCategoryKey}
          onToggleTopBar={props.onToggleTopBar}
          onPickTopBarCategory={props.onPickTopBarCategory}
          disabled={props.saving}
        />
      ) : null}
    </div>
  );
}

function RuntimeUsagePanel(props: {
  runtimeId: string;
  showInTopBar: boolean;
  topBarCategoryKey: string | undefined;
  onToggleTopBar: (next: boolean) => void;
  onPickTopBarCategory: (key: string) => void;
  disabled: boolean;
}) {
  const usage = useQuery({
    queryKey: ["runtime-usage", props.runtimeId],
    queryFn: () => api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${props.runtimeId}/usage`),
    // 5-min cache lives in the daemon; refetching the SPA more often is wasted.
    staleTime: 5 * 60_000,
  });
  const refresh = useMutation({
    mutationFn: () =>
      api<{ usage: RuntimeUsageSummary }>(`/api/runtimes/${props.runtimeId}/usage/refresh`, { method: "POST" }),
    onSuccess: (data) => {
      queryClient.setQueryData(["runtime-usage", props.runtimeId], data);
    },
  });
  const summary = usage.data?.usage;
  const loading = usage.isLoading || refresh.isPending;
  // Default-pin to the first category when the operator hasn't picked one yet.
  // This matches what the cockpit pill renders, so the radio reflects reality
  // before the user has touched anything.
  const effectiveKey =
    props.topBarCategoryKey ?? (summary?.categories[0] ? categoryKey(summary.categories[0]) : undefined);
  return (
    <div className={`runtime-usage-panel ${summary?.status ?? "loading"}`}>
      <div className="runtime-usage-header">
        <span className="runtime-usage-title">Usage</span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => refresh.mutate()}
          disabled={loading}
          title="Refresh usage"
        >
          <RefreshCw size={12} className={loading ? "spinning" : undefined} />
        </Button>
      </div>
      {summary && summary.status !== "healthy" && summary.reason ? (
        <small className="runtime-usage-note">{summary.reason}</small>
      ) : null}
      {summary && summary.categories.length === 0 && summary.status === "healthy" ? (
        <small className="runtime-usage-note">No categories reported.</small>
      ) : null}
      {summary && summary.categories.length > 0 ? (
        <ul className="runtime-usage-list">
          {summary.categories.map((category, index) => {
            const key = categoryKey(category);
            const pinned = key === effectiveKey;
            return (
              <li
                key={`${category.section ?? ""}:${category.label}:${index}`}
                className={`runtime-usage-row ${pinned ? "pinned" : ""}`}
              >
                <label className="runtime-usage-pin" title="Show this limit in the top bar">
                  <input
                    type="radio"
                    name={`top-bar-category-${props.runtimeId}`}
                    checked={pinned}
                    onChange={() => props.onPickTopBarCategory(key)}
                    disabled={props.disabled || !props.showInTopBar}
                  />
                </label>
                <div className="runtime-usage-label">
                  {category.section ? <small className="runtime-usage-section">{category.section}</small> : null}
                  <span>{category.label}</span>
                </div>
                <div className="runtime-usage-bar" aria-hidden>
                  <div
                    className="runtime-usage-bar-fill"
                    style={{ width: `${Math.min(100, category.percentUsed)}%` }}
                  />
                </div>
                <div className="runtime-usage-meta">
                  <strong>{category.percentUsed}%</strong>
                  {category.reset ? (
                    <small title={category.reset}>resets {formatLocalReset(category.reset)}</small>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      <label className="runtime-usage-toggle">
        <input
          type="checkbox"
          checked={props.showInTopBar}
          onChange={(event) => props.onToggleTopBar(event.target.checked)}
          disabled={props.disabled}
        />
        <span>Show in top bar</span>
      </label>
    </div>
  );
}
