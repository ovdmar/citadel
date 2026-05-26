import type { CitadelAction } from "@citadel/contracts";
import { Plus, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export function CitadelActionsPanel() {
  const [actions, setActions] = useState<CitadelAction[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<CitadelAction | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<{ actions: CitadelAction[] }>("/api/citadel-actions");
      setActions(result.actions);
      if (!selectedId && result.actions.length > 0) {
        setSelectedId(result.actions[0]?.id ?? null);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load_failed");
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Reseed the draft from `actions` when:
  //   (a) the selection changes (always reseed — switching rows must reset).
  //   (b) the selection is unchanged but the draft is clean (dirty=false).
  // If the user is mid-edit (dirty=true) and `actions` re-renders for an
  // unrelated reason (sibling save / SSE refresh), unsaved input must NOT be
  // clobbered. Save / Reset / Delete handlers explicitly clear `dirty` after
  // they touch the row so the next refresh re-syncs as expected.
  const lastSelectedRef = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `dirty` is consulted but is not a trigger — only selectedId/actions identity changes should re-evaluate.
  useEffect(() => {
    const selectionChanged = lastSelectedRef.current !== selectedId;
    lastSelectedRef.current = selectedId;
    if (!selectedId) {
      setDraft(null);
      setDirty(false);
      return;
    }
    if (!selectionChanged && dirty) return;
    const selected = actions.find((a) => a.id === selectedId);
    setDraft(selected ? { ...selected } : null);
    if (selectionChanged) setDirty(false);
  }, [selectedId, actions]);

  // Helper: wrap setDraft so any user-driven edit flips dirty=true.
  const editDraft = useCallback((patch: (current: CitadelAction) => CitadelAction) => {
    setDraft((current) => (current ? patch(current) : current));
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ action: CitadelAction }>(`/api/citadel-actions/${encodeURIComponent(draft.id)}`, {
        method: "PUT",
        body: JSON.stringify({
          name: draft.name,
          description: draft.description,
          icon: draft.icon,
          promptTemplate: draft.promptTemplate,
          updatedAt: draft.updatedAt,
        }),
      });
      setActions((current) => current.map((a) => (a.id === result.action.id ? result.action : a)));
      setDraft(result.action);
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleReset = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ action: CitadelAction }>(
        `/api/citadel-actions/${encodeURIComponent(draft.id)}/reset`,
        { method: "POST" },
      );
      setActions((current) => current.map((a) => (a.id === result.action.id ? result.action : a)));
      setDraft(result.action);
      setDirty(false);
      setSavedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : "reset_failed");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleDelete = useCallback(async () => {
    if (!draft || draft.builtIn) return;
    if (!window.confirm(`Delete action "${draft.name}"? This cannot be undone.`)) return;
    setSaving(true);
    setError(null);
    try {
      await api(`/api/citadel-actions/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
      setActions((current) => current.filter((a) => a.id !== draft.id));
      setSelectedId(null);
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_failed");
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const handleCreate = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await api<{ action: CitadelAction }>("/api/citadel-actions", {
        method: "POST",
        body: JSON.stringify({
          name: "New action",
          description: "",
          icon: "",
          promptTemplate: "Describe what the agent should do here.",
        }),
      });
      setActions((current) => [...current, result.action]);
      setSelectedId(result.action.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "create_failed");
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading) {
    return (
      <div className="set-card set-section">
        <div className="set-section-sub">Loading actions…</div>
      </div>
    );
  }

  return (
    <div className="citadel-actions-panel">
      <div className="citadel-actions-list">
        <div className="citadel-actions-list-header">
          <strong>Actions</strong>
          <button
            type="button"
            className="set-btn"
            onClick={() => void handleCreate()}
            disabled={saving}
            title="New custom action"
          >
            <Plus size={12} /> New
          </button>
        </div>
        <ul className="citadel-actions-rows">
          {actions.map((action) => (
            <li key={action.id}>
              <button
                type="button"
                className={`citadel-actions-row${selectedId === action.id ? " is-selected" : ""}`}
                onClick={() => setSelectedId(action.id)}
              >
                <Sparkles size={12} />
                <span className="citadel-actions-row-name">
                  {action.name}
                  {action.builtIn ? <span className="citadel-actions-row-pill">built-in</span> : null}
                </span>
                <span className="citadel-actions-row-desc">{action.description}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="citadel-actions-editor">
        {draft ? (
          <>
            <div className="citadel-actions-editor-row">
              <label htmlFor="citadel-action-name">Name</label>
              <input
                id="citadel-action-name"
                type="text"
                value={draft.name}
                onChange={(event) => editDraft((d) => ({ ...d, name: event.target.value }))}
              />
            </div>
            <div className="citadel-actions-editor-row">
              <label htmlFor="citadel-action-description">Description</label>
              <input
                id="citadel-action-description"
                type="text"
                value={draft.description}
                onChange={(event) => editDraft((d) => ({ ...d, description: event.target.value }))}
              />
            </div>
            <div className="citadel-actions-editor-row">
              <label htmlFor="citadel-action-icon">Icon (lucide name)</label>
              <input
                id="citadel-action-icon"
                type="text"
                value={draft.icon}
                onChange={(event) => editDraft((d) => ({ ...d, icon: event.target.value }))}
                placeholder="e.g. Wand2"
              />
            </div>
            <div className="citadel-actions-editor-row citadel-actions-editor-prompt">
              <label htmlFor="citadel-action-prompt">Prompt template</label>
              <textarea
                id="citadel-action-prompt"
                value={draft.promptTemplate}
                onChange={(event) => editDraft((d) => ({ ...d, promptTemplate: event.target.value }))}
                rows={12}
              />
            </div>
            <div className="citadel-actions-editor-actions">
              <button type="button" className="set-btn-primary" onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              {draft.builtIn ? (
                <button type="button" className="set-btn" onClick={() => void handleReset()} disabled={saving}>
                  <RotateCcw size={12} /> Reset to default
                </button>
              ) : (
                <button type="button" className="set-btn" onClick={() => void handleDelete()} disabled={saving}>
                  <Trash2 size={12} /> Delete
                </button>
              )}
              {savedAt ? <span className="citadel-actions-saved-hint">Saved.</span> : null}
              {error ? <span className="citadel-actions-error">{error}</span> : null}
            </div>
          </>
        ) : (
          <div className="set-section-sub">Select an action on the left.</div>
        )}
      </div>
    </div>
  );
}
