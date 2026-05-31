import type { AgentRuntime, RuntimeUsageSummary, TerminalProfile } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus, RefreshCw, Save, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
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

type ConfigResponse = { config: { agentRuntimes: RuntimeConfig[]; terminal: TerminalProfile } };
type RuntimeSettingsDraft = { agentRuntimes: RuntimeConfig[]; terminal: TerminalProfile };

const PLATFORM_AGENTS: Record<string, { label: string; blurb: string }> = {
  "claude-code": {
    label: "Claude Code",
    blurb: "Anthropic's official CLI. Primary long-running coding agent.",
  },
  codex: {
    label: "Codex",
    blurb: "OpenAI Codex CLI. Prompt-driven coding agent.",
  },
  "cursor-agent": {
    label: "Cursor Agent",
    blurb: "Cursor's headless agent runtime. Prompt-driven and non-interactive friendly.",
  },
  pi: {
    label: "Pi",
    blurb: "Inflection Pi runtime. Prompt-driven conversational agent.",
  },
};

const PLATFORM_IDS = Object.keys(PLATFORM_AGENTS);

export function AgentsPanel(props: { runtimes: AgentRuntime[] }) {
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () => api<ConfigResponse>("/api/config"),
  });
  const [drafts, setDrafts] = useState<RuntimeConfig[]>([]);
  const [terminalDraft, setTerminalDraft] = useState<TerminalProfile>({
    displayName: "Terminal",
    command: "bash",
    args: ["-l"],
  });
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    if (configQuery.data?.config.agentRuntimes) setDrafts(configQuery.data.config.agentRuntimes);
    if (configQuery.data?.config.terminal) setTerminalDraft(configQuery.data.config.terminal);
  }, [configQuery.data?.config.agentRuntimes, configQuery.data?.config.terminal]);

  const save = useMutation({
    mutationFn: (draft: RuntimeSettingsDraft) =>
      api("/api/config", {
        method: "PUT",
        body: JSON.stringify(draft),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["config"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const updateDraft = (id: string, patch: Partial<RuntimeConfig>) => {
    setDrafts((current) => current.map((runtime) => (runtime.id === id ? { ...runtime, ...patch } : runtime)));
  };
  const updateDraftAndPersist = (id: string, patch: Partial<RuntimeConfig>) => {
    const next = drafts.map((runtime) => (runtime.id === id ? { ...runtime, ...patch } : runtime));
    setDrafts(next);
    save.mutate({ agentRuntimes: next, terminal: terminalDraft });
  };
  const updateTerminal = (patch: Partial<TerminalProfile>) => {
    setTerminalDraft((current) => ({ ...current, ...patch }));
  };
  const removeDraft = (id: string) => setDrafts((current) => current.filter((runtime) => runtime.id !== id));
  const addCustom = (entry: { id: string; displayName: string; command: string; args: string[] }) => {
    if (drafts.some((runtime) => runtime.id === entry.id)) return;
    const next: RuntimeConfig[] = [...drafts, { ...entry, supportsPrompt: true }];
    setDrafts(next);
    save.mutate({ agentRuntimes: next, terminal: terminalDraft });
    setShowAdd(false);
  };

  // Build unified row list: status + kind from the runtime, command/args from the draft.
  const draftsById = new Map(drafts.map((draft) => [draft.id, draft]));
  const runtimesById = new Map(props.runtimes.map((runtime) => [runtime.id, runtime]));
  const rowIds = Array.from(new Set([...drafts.map((draft) => draft.id), ...props.runtimes.map((r) => r.id)]));
  const rows = rowIds.map((id) => buildRow(id, runtimesById.get(id), draftsById.get(id)));
  const filtered = rows.filter(
    (row) =>
      !query ||
      row.label.toLowerCase().includes(query.toLowerCase()) ||
      row.id.toLowerCase().includes(query.toLowerCase()) ||
      row.command.toLowerCase().includes(query.toLowerCase()),
  );

  const healthyCount = props.runtimes.filter((runtime) => runtime.health === "healthy").length;
  const dirty =
    JSON.stringify(drafts) !== JSON.stringify(configQuery.data?.config.agentRuntimes ?? []) ||
    JSON.stringify(terminalDraft) !== JSON.stringify(configQuery.data?.config.terminal ?? null);

  return (
    <>
      <TerminalProfilePanel terminal={terminalDraft} onUpdate={updateTerminal} />

      <div className="set-repo-toolbar">
        <div className="set-repo-search">
          <Search size={13} />
          <input
            type="text"
            className="set-repo-search-input"
            placeholder="Search agent runtimes by name, id, or command…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="set-repo-search-clear" onClick={() => setQuery("")} title="Clear">
              ×
            </button>
          ) : null}
        </div>
        <button type="button" className="set-btn set-btn-primary" onClick={() => setShowAdd(true)}>
          <Plus size={13} /> Add agent runtime
        </button>
      </div>

      <div className="set-section-head" style={{ padding: "4px 4px 8px" }}>
        <span className="set-section-eyebrow">Agent runtimes</span>
        <span className="set-section-count">
          {filtered.length}
          {filtered.length !== rows.length ? ` / ${rows.length}` : ""} · {healthyCount} healthy
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="set-empty" style={{ padding: "32px 24px" }}>
          <div className="set-empty-title" style={{ fontSize: 16 }}>
            {query ? `No runtimes match “${query}”` : "No runtimes configured"}
          </div>
          {query ? (
            <button type="button" className="set-btn set-btn-ghost" onClick={() => setQuery("")}>
              Clear search
            </button>
          ) : null}
        </div>
      ) : (
        <div className="set-agent-cards">
          {filtered.map((row) => (
            <AgentCard
              key={row.id}
              row={row}
              onUpdate={(patch) => updateDraft(row.id, patch)}
              onRemove={() => removeDraft(row.id)}
              onToggleTopBar={(next) => updateDraftAndPersist(row.id, { showUsageInTopBar: next })}
              onPickTopBarCategory={(key) => updateDraftAndPersist(row.id, { topBarCategoryKey: key })}
              saving={save.isPending}
            />
          ))}
        </div>
      )}

      <div className="set-form-foot" style={{ paddingLeft: 0, paddingRight: 0 }}>
        <button
          type="button"
          className="set-btn set-btn-primary"
          onClick={() => save.mutate({ agentRuntimes: drafts, terminal: terminalDraft })}
          disabled={save.isPending || !dirty}
        >
          <Save size={13} /> Save changes
        </button>
        {save.error ? <span className="form-error">{String(save.error)}</span> : null}
      </div>

      {showAdd ? (
        <AddRuntimeModal onClose={() => setShowAdd(false)} onAdd={addCustom} existingIds={drafts.map((d) => d.id)} />
      ) : null}
    </>
  );
}

type AgentRowData = {
  id: string;
  label: string;
  desc: string;
  isBuiltIn: boolean;
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  healthReason: string | null;
  command: string;
  args: string;
  runtime: AgentRuntime | undefined;
  draft: RuntimeConfig | undefined;
};

function buildRow(id: string, runtime: AgentRuntime | undefined, draft: RuntimeConfig | undefined): AgentRowData {
  const platformMeta = PLATFORM_IDS.includes(id) ? PLATFORM_AGENTS[id] : undefined;
  return {
    id,
    label: platformMeta?.label ?? draft?.displayName ?? runtime?.displayName ?? id,
    desc: platformMeta?.blurb ?? (draft ? "Custom runtime added in settings." : "Configured runtime."),
    isBuiltIn: PLATFORM_IDS.includes(id),
    health: runtime?.health ?? "unknown",
    healthReason: runtime?.healthReason ?? null,
    command: draft?.command ?? runtime?.command ?? "",
    args: (draft?.args ?? runtime?.args ?? []).join(" "),
    runtime,
    draft,
  };
}

function AgentCard(props: {
  row: AgentRowData;
  onUpdate: (patch: Partial<RuntimeConfig>) => void;
  onRemove: () => void;
  onToggleTopBar: (next: boolean) => void;
  onPickTopBarCategory: (key: string) => void;
  saving: boolean;
}) {
  const { row } = props;
  const showsUsage = row.runtime?.capabilities.supportsUsage && row.runtime.health === "healthy";
  const isUnavailable = row.health === "unavailable";
  return (
    <div className={`set-agent-card is-${row.health}`}>
      <div className="set-agent-card-head">
        <div className="set-agent-card-title">
          <span className="set-agent-card-name">{row.label}</span>
          <span className={`set-pill ${row.isBuiltIn ? "set-pill-mute" : "set-pill-supported"}`}>
            {row.isBuiltIn ? "built-in" : "custom"}
          </span>
        </div>
        <span className={`set-pill ${healthPillClass(row.health)}`} title={row.healthReason ?? undefined}>
          {healthPillLabel(row.health)}
        </span>
      </div>

      <div className={`set-agent-card-desc ${isUnavailable ? "is-bad" : ""}`}>
        {isUnavailable ? (row.healthReason ?? `\`${row.command}\` not on PATH`) : row.desc}
      </div>

      <div className="set-agent-card-fields">
        <label className="set-agent-card-field">
          <span className="set-agent-card-field-label">Command</span>
          <input
            className="set-input is-mono"
            value={row.command}
            onChange={(event) => props.onUpdate({ command: event.target.value })}
            aria-label={`Command for ${row.id}`}
          />
        </label>
        <label className="set-agent-card-field">
          <span className="set-agent-card-field-label">Args</span>
          <input
            className="set-input is-mono"
            value={row.args}
            placeholder="(none)"
            onChange={(event) =>
              props.onUpdate({
                args: event.target.value
                  .split(/\s+/)
                  .map((part) => part.trim())
                  .filter(Boolean),
              })
            }
            aria-label={`Args for ${row.id}`}
          />
        </label>
      </div>

      {showsUsage ? (
        <RuntimeUsagePanel
          runtimeId={row.id}
          showInTopBar={row.draft?.showUsageInTopBar ?? false}
          topBarCategoryKey={row.draft?.topBarCategoryKey}
          onToggleTopBar={props.onToggleTopBar}
          onPickTopBarCategory={props.onPickTopBarCategory}
          disabled={props.saving}
        />
      ) : null}

      {!row.isBuiltIn ? (
        <div className="set-agent-card-foot">
          <button
            type="button"
            className="set-btn set-btn-danger set-btn-sm"
            onClick={props.onRemove}
            title="Remove custom runtime"
          >
            <Trash2 size={11} /> Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}

function TerminalProfilePanel(props: {
  terminal: TerminalProfile;
  onUpdate: (patch: Partial<TerminalProfile>) => void;
}) {
  return (
    <div className="set-card set-section" style={{ marginBottom: 16 }}>
      <div className="set-section-head">
        <span className="set-section-eyebrow">Terminal</span>
        <span className="set-pill set-pill-mute">workspace tabs</span>
      </div>
      <div className="set-section-sub">
        The plain workspace terminal launched from the cockpit. It is separate from agent runtimes.
      </div>
      <div className="set-form-grid">
        <label className="set-form-col">
          <span className="set-field-label">Display name</span>
          <input
            className="set-input"
            value={props.terminal.displayName}
            onChange={(event) => props.onUpdate({ displayName: event.target.value })}
          />
        </label>
        <label className="set-form-col">
          <span className="set-field-label">Command</span>
          <input
            className="set-input is-mono"
            value={props.terminal.command}
            onChange={(event) => props.onUpdate({ command: event.target.value })}
          />
        </label>
        <label className="set-form-col">
          <span className="set-field-label">Args</span>
          <input
            className="set-input is-mono"
            value={props.terminal.args.join(" ")}
            placeholder="(none)"
            onChange={(event) =>
              props.onUpdate({
                args: event.target.value
                  .split(/\s+/)
                  .map((part) => part.trim())
                  .filter(Boolean),
              })
            }
          />
        </label>
      </div>
    </div>
  );
}

function healthPillClass(health: AgentRowData["health"]): string {
  if (health === "healthy") return "set-pill-ok";
  if (health === "degraded") return "set-pill-warn";
  if (health === "unavailable") return "set-pill-bad";
  return "set-pill-mute";
}
function healthPillLabel(health: AgentRowData["health"]): string {
  if (health === "healthy") return "Healthy";
  if (health === "degraded") return "Stale";
  if (health === "unavailable") return "Unavail.";
  return "Unknown";
}

export const RuntimesPanel = AgentsPanel;

// ─── Add custom runtime modal ──────────────────────────────────────────────
function AddRuntimeModal(props: {
  onClose: () => void;
  onAdd: (entry: { id: string; displayName: string; command: string; args: string[] }) => void;
  existingIds: string[];
}) {
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  // Auto-derive id from display name until the user types one explicitly,
  // so most users only fill in two fields.
  const [idTouched, setIdTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const derivedId = idTouched ? id : slugify(displayName);
  const duplicate = props.existingIds.includes(derivedId);
  const valid = derivedId && displayName.trim() && command.trim() && !duplicate;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    props.onAdd({
      id: derivedId,
      displayName: displayName.trim(),
      command: command.trim(),
      args: args
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="set-modal-scrim" role="presentation" onMouseDown={props.onClose}>
      <div className="set-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="set-modal-head">
          <div>
            <div className="set-modal-eyebrow">Agent runtimes</div>
            <div className="set-modal-title">Add agent runtime</div>
          </div>
          <button type="button" className="set-icon-btn" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="set-modal-body">
            <label className="set-modal-field">
              <span className="set-field-label">Display name</span>
              <input
                ref={nameRef}
                className="set-input"
                placeholder="e.g. Aider"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </label>
            <label className="set-modal-field">
              <span className="set-field-label">
                Id <span className="set-field-opt">(auto-derived from name)</span>
              </span>
              <input
                className="set-input is-mono"
                placeholder="aider"
                value={derivedId}
                onChange={(event) => {
                  setIdTouched(true);
                  setId(slugify(event.target.value));
                }}
              />
              {duplicate ? <span className="form-error">An agent with this id already exists.</span> : null}
            </label>
            <label className="set-modal-field">
              <span className="set-field-label">Command</span>
              <input
                className="set-input is-mono"
                placeholder="aider"
                value={command}
                onChange={(event) => setCommand(event.target.value)}
              />
            </label>
            <label className="set-modal-field">
              <span className="set-field-label">
                Args <span className="set-field-opt">(space-separated)</span>
              </span>
              <input
                className="set-input is-mono"
                placeholder="--no-auto-commits"
                value={args}
                onChange={(event) => setArgs(event.target.value)}
              />
            </label>
            <div className="set-modal-hint">
              Citadel will launch this command inside a workspace as a new agent runtime. Health is verified by checking
              the command exists on PATH after you save.
            </div>
          </div>

          <div className="set-modal-foot">
            <button type="button" className="set-btn set-btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="set-btn set-btn-primary" disabled={!valid}>
              <Plus size={13} /> Add runtime
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ─── Usage panel — preserved feature, restyled wrapper, rendered inline ────
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
  const effectiveKey =
    props.topBarCategoryKey ?? (summary?.categories[0] ? categoryKey(summary.categories[0]) : undefined);
  return (
    <div className={`runtime-usage-panel ${summary?.status ?? "loading"}`}>
      <div className="runtime-usage-header">
        <span className="runtime-usage-title">Usage</span>
        <button
          type="button"
          className="set-icon-btn"
          onClick={() => refresh.mutate()}
          disabled={loading}
          title="Refresh usage"
        >
          <RefreshCw size={12} className={loading ? "spinning" : undefined} />
        </button>
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
