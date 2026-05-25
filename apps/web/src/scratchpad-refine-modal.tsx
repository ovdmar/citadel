import type { CitadelAction, Repo } from "@citadel/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AlertTriangle, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const REFINE_ACTION_ID = "refine-scratchpad";

type RefineResult =
  | {
      ok: true;
      workspaceId: string;
      sessionId: string | null;
      operationId: string;
      warning?: string;
    }
  | {
      ok: false;
      error: "runtime_unavailable" | "repo_required" | "launch_failed" | "invalid_input";
      detail: string;
      workspaceId?: string;
    };

export type ScratchpadRefineModalProps = {
  open: boolean;
  onClose: () => void;
};

export function ScratchpadRefineModal(props: ScratchpadRefineModalProps) {
  const { open, onClose } = props;
  const navigate = useNavigate();
  const [action, setAction] = useState<CitadelAction | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [activeRepoId, setActiveRepoId] = useState<string>("");
  const [prompt, setPrompt] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [confirmWarning, setConfirmWarning] = useState(false);

  // Load on open.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setWarning(null);
    setConfirmWarning(false);
    let cancelled = false;
    void (async () => {
      try {
        const [actionsResult, stateResult] = await Promise.all([
          api<{ actions: CitadelAction[] }>("/api/citadel-actions"),
          api<{ repos: Repo[] }>("/api/state"),
        ]);
        if (cancelled) return;
        const refineAction = actionsResult.actions.find((a) => a.id === REFINE_ACTION_ID);
        setAction(refineAction ?? null);
        setPrompt(refineAction?.promptTemplate ?? "");
        setRepos(stateResult.repos);
        // Default to the first repo if no prior selection — UI mirrors the
        // refine endpoint's resolution (which picks the first workspace's repo).
        setActiveRepoId((current) => current || stateResult.repos[0]?.id || "");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load_failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Detect in-progress safeguard removal on every prompt change. Mirrors the
  // soft warning the daemon issues — but surfacing it client-side lets the
  // user fix the prompt before submit.
  useEffect(() => {
    if (!open) return;
    if (!prompt.toLowerCase().includes("in-progress")) {
      setWarning(
        "Your prompt does not mention 'in-progress' — blocks owned by other agents may be modified by the refine agent.",
      );
    } else {
      setWarning(null);
      setConfirmWarning(false);
    }
  }, [prompt, open]);

  const handleSubmit = useCallback(async () => {
    if (warning && !confirmWarning) {
      setConfirmWarning(true);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<RefineResult>("/api/scratchpad/refine", {
        method: "POST",
        body: JSON.stringify({ prompt, repoId: activeRepoId || undefined }),
      });
      if (!result.ok) {
        setError(result.detail || result.error);
        return;
      }
      onClose();
      // Navigate to the launched workspace by leaving the drawer open on the
      // cockpit. The cockpit honors `?workspaceId=` via existing state, but we
      // simply land on `/` and let the SSE refresh select the new workspace.
      void navigate({ to: "/" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "refine_failed");
    } finally {
      setSubmitting(false);
    }
  }, [prompt, activeRepoId, warning, confirmWarning, navigate, onClose]);

  const handleSaveAsDefault = useCallback(async () => {
    if (!action) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api<{ action: CitadelAction }>(`/api/citadel-actions/${REFINE_ACTION_ID}`, {
        method: "PUT",
        body: JSON.stringify({
          promptTemplate: prompt,
          updatedAt: action.updatedAt,
        }),
      });
      setAction(result.action);
    } catch (err) {
      setError(err instanceof Error ? err.message : "save_failed");
    } finally {
      setSubmitting(false);
    }
  }, [action, prompt]);

  if (!open) return null;

  return (
    <dialog className="scratchpad-refine-overlay" open aria-modal="true" aria-label="Refine scratchpad">
      <button type="button" className="scratchpad-refine-backdrop" onClick={onClose} aria-label="Close refine modal" />
      <div className="scratchpad-refine-panel">
        <header className="scratchpad-refine-header">
          <span>Refine scratchpad</span>
          <button type="button" className="scratchpad-refine-close" onClick={onClose} aria-label="Close refine modal">
            <X size={14} />
          </button>
        </header>
        <div className="scratchpad-refine-body">
          {loading ? (
            <div className="scratchpad-refine-loading">Loading…</div>
          ) : (
            <>
              <div className="scratchpad-refine-row">
                <span className="scratchpad-refine-label">Will run in</span>
                {repos.length === 0 ? (
                  <span className="scratchpad-refine-empty">
                    No repository registered. Add one in Settings → Repositories first.
                  </span>
                ) : (
                  <select
                    value={activeRepoId}
                    onChange={(event) => setActiveRepoId(event.target.value)}
                    aria-label="Target repository for refine"
                  >
                    {repos.map((repo) => (
                      <option key={repo.id} value={repo.id}>
                        {repo.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="scratchpad-refine-row scratchpad-refine-prompt-row">
                <span className="scratchpad-refine-label">Prompt</span>
                <textarea
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  rows={14}
                  aria-label="Refine prompt"
                />
              </div>
              {warning ? (
                <div className="scratchpad-refine-warning" role="alert">
                  <AlertTriangle size={14} />
                  <span>{warning}</span>
                </div>
              ) : null}
              {error ? (
                <div className="scratchpad-refine-error" role="alert">
                  {error}
                </div>
              ) : null}
              <div className="scratchpad-refine-actions">
                <button
                  type="button"
                  className="set-btn-primary"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || repos.length === 0 || prompt.trim().length === 0}
                >
                  {submitting ? "Launching…" : warning && !confirmWarning ? "Launch anyway" : "Launch refine agent"}
                </button>
                <button
                  type="button"
                  className="set-btn"
                  onClick={() => void handleSaveAsDefault()}
                  disabled={submitting || !action || prompt === action.promptTemplate}
                  title="Persist this prompt as the default for the refine-scratchpad Citadel Action"
                >
                  Save as default
                </button>
                <button type="button" className="set-btn" onClick={onClose} disabled={submitting}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}
