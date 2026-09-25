import type { ActionTemplate, AgentRuntime, LaunchSettings, RoleTemplate } from "@citadel/contracts";
import { RotateCcw, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";

type AgentTemplatesResponse = { roles: RoleTemplate[] };
type Draft = { role: RoleTemplate; actionId: string | null };

export function AgentTemplatesPanel(props: { runtimes: AgentRuntime[] }) {
  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [selectedRole, setSelectedRole] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<AgentTemplatesResponse>("/api/agent-templates");
      setRoles(result.roles);
      setSelectedRole((current) => current ?? result.roles[0]?.role ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const lastSelectedRef = useRef<string | null>(null);
  useEffect(() => {
    const selectionChanged = lastSelectedRef.current !== selectedRole;
    lastSelectedRef.current = selectedRole;
    if (!selectedRole) {
      setDraft(null);
      setDirty(false);
      return;
    }
    if (!selectionChanged && dirty) return;
    const role = roles.find((entry) => entry.role === selectedRole);
    if (!role) {
      setDraft(null);
      return;
    }
    setDraft({ role: cloneRole(role), actionId: role.actions[0]?.id ?? null });
    if (selectionChanged) setDirty(false);
  }, [selectedRole, roles, dirty]);

  const selectedAction = useMemo(
    () => draft?.role.actions.find((action) => action.id === draft.actionId) ?? null,
    [draft],
  );

  const editRole = useCallback((patch: (role: RoleTemplate) => RoleTemplate) => {
    setDraft((current) => (current ? { ...current, role: patch(current.role) } : current));
    setDirty(true);
  }, []);

  const editAction = useCallback((patch: (action: ActionTemplate) => ActionTemplate) => {
    setDraft((current) => {
      if (!current?.actionId) return current;
      return {
        ...current,
        role: {
          ...current.role,
          actions: current.role.actions.map((action) => (action.id === current.actionId ? patch(action) : action)),
        },
      };
    });
    setDirty(true);
  }, []);

  const saveRole = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ role: RoleTemplate }>(`/api/agent-templates/roles/${draft.role.role}`, {
        method: "PUT",
        body: JSON.stringify({
          systemPrompt: draft.role.systemPrompt,
          launchSettings: draft.role.launchSettings,
          updatedAt: draft.role.updatedAt,
        }),
      });
      setRoles((current) => current.map((role) => (role.role === result.role.role ? result.role : role)));
      setDraft((current) => (current ? { ...current, role: cloneRole(result.role) } : current));
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const saveAction = useCallback(async () => {
    if (!selectedAction) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ action: ActionTemplate }>(
        `/api/agent-templates/actions/${encodeURIComponent(selectedAction.id)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            prompt: selectedAction.prompt,
            launchSettings: selectedAction.launchSettings,
            executionMode: selectedAction.executionMode,
            updatedAt: selectedAction.updatedAt,
          }),
        },
      );
      setRoles((current) => replaceAction(current, result.action));
      setDraft((current) =>
        current ? { ...current, role: replaceAction([current.role], result.action)[0] ?? current.role } : current,
      );
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }, [selectedAction]);

  const resetRole = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ role: RoleTemplate }>(`/api/agent-templates/roles/${draft.role.role}/reset`, {
        method: "POST",
      });
      setRoles((current) => current.map((role) => (role.role === result.role.role ? result.role : role)));
      setDraft({ role: cloneRole(result.role), actionId: result.role.actions[0]?.id ?? null });
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset_failed");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const resetAction = useCallback(async () => {
    if (!selectedAction) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ action: ActionTemplate }>(
        `/api/agent-templates/actions/${encodeURIComponent(selectedAction.id)}/reset`,
        { method: "POST" },
      );
      setRoles((current) => replaceAction(current, result.action));
      setDraft((current) =>
        current ? { ...current, role: replaceAction([current.role], result.action)[0] ?? current.role } : current,
      );
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset_failed");
    } finally {
      setSaving(false);
    }
  }, [selectedAction]);

  if (loading) {
    return (
      <div className="set-card set-section">
        <div className="set-section-sub">Loading templates...</div>
      </div>
    );
  }

  return (
    <div className="citadel-actions-panel">
      <div className="citadel-actions-list">
        <div className="citadel-actions-list-header">
          <strong>Roles</strong>
        </div>
        <ul className="citadel-actions-rows">
          {roles.map((role) => (
            <li key={role.role}>
              <button
                type="button"
                className={`citadel-actions-row${selectedRole === role.role ? " is-selected" : ""}`}
                onClick={() => setSelectedRole(role.role)}
              >
                <Sparkles size={12} />
                <span className="citadel-actions-row-name">
                  {role.displayName}
                  <span className="citadel-actions-row-pill">built-in</span>
                </span>
                <span className="citadel-actions-row-desc">{role.launchSettings.runtimeId}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="citadel-actions-editor">
        {draft ? (
          <>
            <div className="citadel-actions-editor-row">
              <label htmlFor="agent-role-prompt">System prompt</label>
              <textarea
                id="agent-role-prompt"
                value={draft.role.systemPrompt}
                onChange={(event) => editRole((role) => ({ ...role, systemPrompt: event.target.value }))}
                rows={8}
              />
            </div>
            <LaunchSettingsEditor
              idPrefix={`role-${draft.role.role}`}
              runtimes={props.runtimes}
              value={draft.role.launchSettings}
              onChange={(launchSettings) => editRole((role) => ({ ...role, launchSettings }))}
            />
            <div className="citadel-actions-editor-actions">
              <button type="button" className="set-btn-primary" onClick={() => void saveRole()} disabled={saving}>
                {saving ? "Saving..." : "Save role"}
              </button>
              <button type="button" className="set-btn" onClick={() => void resetRole()} disabled={saving}>
                <RotateCcw size={12} /> Reset role
              </button>
            </div>
            {draft.role.actions.length ? (
              <>
                <div className="citadel-actions-list-header citadel-actions-list-header--inline">
                  <strong>Actions</strong>
                </div>
                <div className="agent-template-actions">
                  {draft.role.actions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      className={`set-btn ${draft.actionId === action.id ? "is-active" : ""}`}
                      onClick={() => setDraft((current) => (current ? { ...current, actionId: action.id } : current))}
                    >
                      {action.displayName}
                    </button>
                  ))}
                </div>
                {selectedAction ? (
                  <>
                    <div className="citadel-actions-editor-row citadel-actions-editor-prompt">
                      <label htmlFor="agent-action-prompt">Action prompt</label>
                      <textarea
                        id="agent-action-prompt"
                        value={selectedAction.prompt}
                        onChange={(event) => editAction((action) => ({ ...action, prompt: event.target.value }))}
                        rows={7}
                      />
                    </div>
                    <LaunchSettingsEditor
                      idPrefix={`action-${selectedAction.id}`}
                      runtimes={props.runtimes}
                      value={selectedAction.launchSettings}
                      onChange={(launchSettings) => editAction((action) => ({ ...action, launchSettings }))}
                    />
                    <div className="citadel-actions-editor-row">
                      <label htmlFor="agent-action-execution">Execution</label>
                      <select
                        id="agent-action-execution"
                        className="set-select"
                        value={selectedAction.executionMode}
                        onChange={(event) =>
                          editAction((action) => ({
                            ...action,
                            executionMode: event.currentTarget.value as ActionTemplate["executionMode"],
                          }))
                        }
                      >
                        <option value="new_session">New session</option>
                        <option value="existing_session">Existing session</option>
                      </select>
                    </div>
                    <div className="citadel-actions-editor-actions">
                      <button
                        type="button"
                        className="set-btn-primary"
                        onClick={() => void saveAction()}
                        disabled={saving}
                      >
                        {saving ? "Saving..." : "Save action"}
                      </button>
                      <button type="button" className="set-btn" onClick={() => void resetAction()} disabled={saving}>
                        <RotateCcw size={12} /> Reset action
                      </button>
                    </div>
                  </>
                ) : null}
              </>
            ) : null}
            {savedAt ? <span className="citadel-actions-saved-hint">Saved.</span> : null}
            {dirty ? <span className="citadel-actions-saved-hint">Unsaved changes.</span> : null}
            {error ? <span className="citadel-actions-error">{error}</span> : null}
          </>
        ) : (
          <div className="set-section-sub">Select a role.</div>
        )}
      </div>
    </div>
  );
}

function LaunchSettingsEditor(props: {
  idPrefix: string;
  runtimes: AgentRuntime[];
  value: LaunchSettings;
  onChange: (settings: LaunchSettings) => void;
}) {
  const runtimes = ensureSelectedRuntime(props.runtimes, props.value.runtimeId);
  const selected = runtimes.find((runtime) => runtime.id === props.value.runtimeId);
  const launch = selected?.launchCapabilities;
  const models = launch?.models.filter((model) => !model.deprecated) ?? [];
  const update = (patch: Partial<LaunchSettings>) => props.onChange({ ...props.value, ...patch });
  return (
    <div className="agent-template-launch-grid">
      <div className="citadel-actions-editor-row">
        <label htmlFor={`${props.idPrefix}-runtime`}>Runtime</label>
        <select
          id={`${props.idPrefix}-runtime`}
          className="set-select"
          value={props.value.runtimeId}
          onChange={(event) =>
            update({
              runtimeId: event.currentTarget.value,
              model: null,
              effort: null,
              fastMode: null,
              contextMode: null,
            })
          }
        >
          {runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {runtime.displayName}
            </option>
          ))}
        </select>
      </div>
      <div className="citadel-actions-editor-row">
        <label htmlFor={`${props.idPrefix}-model`}>Model</label>
        <select
          id={`${props.idPrefix}-model`}
          className="set-select"
          value={props.value.model ?? ""}
          onChange={(event) => update({ model: event.currentTarget.value || null })}
        >
          <option value="">{launch?.defaultModel ? `Default (${launch.defaultModel})` : "Runtime default"}</option>
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </div>
      <div className="citadel-actions-editor-row">
        <label htmlFor={`${props.idPrefix}-effort`}>Effort</label>
        <select
          id={`${props.idPrefix}-effort`}
          className="set-select"
          value={props.value.effort ?? ""}
          onChange={(event) => update({ effort: event.currentTarget.value || null })}
        >
          <option value="">Runtime default</option>
          {(launch?.effortValues ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      <div className="citadel-actions-editor-row">
        <label htmlFor={`${props.idPrefix}-context`}>Context</label>
        <select
          id={`${props.idPrefix}-context`}
          className="set-select"
          value={props.value.contextMode ?? ""}
          onChange={(event) => update({ contextMode: event.currentTarget.value || null })}
        >
          <option value="">Runtime default</option>
          {(launch?.contextModes ?? []).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>
      {launch?.supportsFastMode ? (
        <label className="agent-template-check">
          <input
            type="checkbox"
            checked={props.value.fastMode === true}
            onChange={(event) => update({ fastMode: event.currentTarget.checked ? true : null })}
          />
          <span>Fast mode</span>
        </label>
      ) : null}
    </div>
  );
}

function cloneRole(role: RoleTemplate): RoleTemplate {
  return {
    ...role,
    launchSettings: { ...role.launchSettings },
    actions: role.actions.map((action) => ({ ...action, launchSettings: { ...action.launchSettings } })),
  };
}

function replaceAction(roles: RoleTemplate[], action: ActionTemplate): RoleTemplate[] {
  return roles.map((role) =>
    role.role === action.role
      ? {
          ...role,
          actions: role.actions.map((entry) => (entry.id === action.id ? action : entry)),
        }
      : role,
  );
}

function ensureSelectedRuntime(runtimes: AgentRuntime[], selectedId: string): AgentRuntime[] {
  if (!selectedId || runtimes.some((runtime) => runtime.id === selectedId)) return runtimes;
  return [
    ...runtimes,
    {
      id: selectedId,
      displayName: `${selectedId} (not configured)`,
      command: "",
      args: [],
      health: "unavailable",
      healthReason: "Runtime is not configured.",
      capabilities: {
        supportsPrompt: false,
        supportsResume: false,
        supportsModelSelection: false,
        supportsTranscript: false,
        supportsStatusDetection: true,
        supportsNonInteractiveGoal: false,
        supportsShell: true,
        supportsUsage: false,
        supportsTui: false,
      },
    },
  ];
}
