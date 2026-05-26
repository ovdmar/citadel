// Settings → Restore lost sessions.
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

export function RestorePanel() {
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
    mutationFn: async (workspaceId: string) => {
      setInFlight(workspaceId);
      setError(null);
      try {
        return await api<{ session: { id: string } }>("/api/restore/run", {
          method: "POST",
          body: JSON.stringify({ workspaceId }),
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
    <div className="set-card set-section">
      <div className="set-section-head">
        <span className="set-section-eyebrow">Restore lost sessions</span>
        <span className="set-section-count">{total}</span>
      </div>
      <div className="set-section-sub">
        Workspaces whose conversation Citadel can resume — the agent died (daemon restart, crash, or you stopped it) but
        the runtime's transcript is intact and its session UUID is registered. Restoring spawns a fresh tmux pane and
        runs the runtime with its resume flag, continuing from the last message.
      </div>

      {error ? (
        <div className="set-attn set-attn--bad" style={{ marginTop: 10 }}>
          <span className="set-attn-dot" />
          <div className="set-attn-text">
            <div className="set-attn-title">Restore failed</div>
            <div className="set-attn-detail">{error}</div>
          </div>
        </div>
      ) : null}

      {loading ? (
        <div className="set-sum-empty" style={{ marginTop: 12 }}>
          Scanning…
        </div>
      ) : total === 0 ? (
        <div className="set-sum-empty" style={{ marginTop: 12 }}>
          Nothing to restore — every workspace with a registered session is already live.
        </div>
      ) : (
        <div className="set-attn-list" style={{ marginTop: 8 }}>
          {candidates.map((candidate) => (
            <RestoreRow
              key={candidate.sourceSessionId}
              candidate={candidate}
              busy={inFlight === candidate.workspaceId}
              disabled={inFlight !== null}
              onRestore={() => restore.mutate(candidate.workspaceId)}
            />
          ))}
        </div>
      )}
    </div>
  );
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
    <div className="set-attn set-attn--warn">
      <span className="set-attn-dot" />
      <div className="set-attn-text">
        <div className="set-attn-title">{candidate.workspaceName}</div>
        <div className="set-attn-detail">
          <span className="set-mono">{candidate.runtimeId}</span> · last active {ago} ·{" "}
          <span className="set-mono">{candidate.runtimeSessionId.slice(0, 8)}</span>
        </div>
      </div>
      <button type="button" className="set-btn" onClick={props.onRestore} disabled={props.disabled || props.busy}>
        <RotateCcw size={12} style={{ marginRight: 6, verticalAlign: "-2px" }} />
        {props.busy ? "Restoring…" : "Restore"}
      </button>
    </div>
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
