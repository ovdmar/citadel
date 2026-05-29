// Restore lost sessions. Surfaced as a modal (cockpit-global) so the user
// can reach it from the boot banner OR Settings → Restore without the
// surrounding settings chrome stealing focus.
//
// Reads candidates from /api/restore/candidates (every workspace whose
// most-recent agent_sessions row carries a runtime_session_id but no live
// counterpart). For each, renders an inline row with the workspace name,
// runtime, UUID, and last activity, plus a Restore button that POSTs to
// /api/restore/run — the server then spawns a new agent session with the
// runtime's resume flag (`claude --resume <uuid>`), inheriting the same
// conversation. Disabled empty state when there's nothing to restore.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { useState } from "react";
import { api } from "./api.js";
import { Modal } from "./modals.js";

type RestoreCandidate = {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeId: string;
  runtimeSessionId: string;
  lastActivityAt: string;
  sourceSessionId: string;
};

type CandidatesResponse = { candidates: RestoreCandidate[] };

// Bare panel body (the candidate list + action buttons). Used by both the
// modal and the legacy Settings tab — the modal wraps it in <Modal>, the
// settings tab embeds it directly under a section header.
export function RestorePanelBody() {
  const queryClient = useQueryClient();
  const candidatesQuery = useQuery({
    queryKey: ["restore-candidates"],
    queryFn: () => api<CandidatesResponse>("/api/restore/candidates"),
    // Cheap query; refetch when the user comes back to the tab so the list
    // reflects sessions that started/stopped while they were away.
    refetchOnWindowFocus: true,
  });
  const [inFlight, setInFlight] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const restore = useMutation({
    mutationFn: async (input: { workspaceId: string; runtimeSessionId: string }) => {
      // Key the in-flight indicator by UUID so multiple candidates from the
      // same workspace don't all flip to "Restoring…" when one is clicked.
      setInFlight(input.runtimeSessionId);
      setError(null);
      try {
        return await api<{ session: { id: string } }>("/api/restore/run", {
          method: "POST",
          body: JSON.stringify(input),
        });
      } finally {
        setInFlight(null);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["restore-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "restore_failed");
    },
  });

  const candidates = candidatesQuery.data?.candidates ?? [];
  const total = candidates.length;
  const loading = candidatesQuery.isLoading;

  return (
    <div className="restore-panel">
      <p className="restore-panel__lead">
        Workspaces whose conversation Citadel can resume — the agent died (daemon restart, crash, or you stopped it) but
        the runtime's transcript is intact and its session UUID is registered. Restoring spawns a fresh tmux pane and
        runs the runtime with its resume flag, continuing from the last message.
      </p>

      {error ? (
        <div className="restore-panel__error">
          <strong>Restore failed:</strong> {error}
        </div>
      ) : null}

      {loading ? (
        <div className="restore-panel__empty">Scanning…</div>
      ) : total === 0 ? (
        <div className="restore-panel__empty">
          Nothing to restore — every workspace with a registered session is already live.
        </div>
      ) : (
        <ul className="restore-panel__list">
          {candidates.map((candidate) => (
            <RestoreRow
              key={candidate.sourceSessionId}
              candidate={candidate}
              busy={inFlight === candidate.runtimeSessionId}
              disabled={inFlight !== null}
              onRestore={() =>
                restore.mutate({
                  workspaceId: candidate.workspaceId,
                  runtimeSessionId: candidate.runtimeSessionId,
                })
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// Modal wrapper — backdrop-blur overlay, dismiss on Esc/click-outside.
// Open this from the boot-time RestoreBanner and from Settings → Restore.
export function RestoreModal(props: { onClose: () => void }) {
  return (
    <Modal title="Restore lost sessions" onClose={props.onClose}>
      <RestorePanelBody />
    </Modal>
  );
}

// Back-compat shim: keeps the Settings → Restore tab rendering inline. New
// code should prefer RestoreModal; this exists so the old route doesn't
// stop working if the user lands directly on it.
export function RestorePanel() {
  return <RestorePanelBody />;
}

function RestoreRow(props: {
  candidate: RestoreCandidate;
  busy: boolean;
  disabled: boolean;
  onRestore: () => void;
}) {
  const { candidate } = props;
  const ago = relativeTime(candidate.lastActivityAt);
  return (
    <li className="restore-panel__row">
      <div className="restore-panel__row-text">
        <div className="restore-panel__row-title">{candidate.workspaceName}</div>
        <div className="restore-panel__row-detail">
          <span className="restore-panel__mono">{candidate.runtimeId}</span> · last active {ago} ·{" "}
          <span className="restore-panel__mono">{candidate.runtimeSessionId.slice(0, 8)}</span>
        </div>
      </div>
      <button
        type="button"
        className="restore-panel__btn"
        onClick={props.onRestore}
        disabled={props.disabled || props.busy}
      >
        <RotateCcw size={12} style={{ marginRight: 6, verticalAlign: "-2px" }} />
        {props.busy ? "Restoring…" : "Restore"}
      </button>
    </li>
  );
}

// "3 minutes ago" / "2 hours ago" / "yesterday" without a date library —
// the precise wall-clock time isn't load-bearing here; the user just needs
// to recognize which session was which.
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "unknown";
  const diff = Date.now() - t;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}
