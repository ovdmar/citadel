import type { ScheduledAgentRun } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

/**
 * History drawer + per-row log viewer for a single scheduled agent. Polls
 * /runs every 5s and subscribes to the `scheduled-agent.run-row` SSE event
 * so queued/running/terminal transitions surface immediately.
 */
export function ScheduledAgentRunHistory(props: { agentId: string }) {
  const runs = useQuery<{ runs: ScheduledAgentRun[] }>({
    queryKey: ["scheduled-agent-runs", props.agentId],
    queryFn: () => api<{ runs: ScheduledAgentRun[] }>(`/api/scheduled-agents/${props.agentId}/runs`),
    refetchInterval: 5000,
  });
  useEffect(() => {
    const events = new EventSource("/events");
    const refresh = (event: MessageEvent) => {
      try {
        // The SSE envelope is { id, type, timestamp, source, payload }; the
        // payload is { scheduledAgentId, runId, status }. Reading
        // data.scheduledAgentId directly silently no-ops.
        const data = JSON.parse(event.data);
        if (data?.payload?.scheduledAgentId === props.agentId) {
          queryClient.invalidateQueries({ queryKey: ["scheduled-agent-runs", props.agentId] });
        }
      } catch {
        // ignore malformed payloads
      }
    };
    events.addEventListener("scheduled-agent.run-row", refresh);
    return () => {
      events.removeEventListener("scheduled-agent.run-row", refresh);
      events.close();
    };
  }, [props.agentId]);
  const list = runs.data?.runs ?? [];
  if (!list.length) {
    return <div className="scheduled-agent-history empty compact">No runs yet.</div>;
  }
  return (
    <div className="scheduled-agent-history">
      <table className="scheduled-agent-history-table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Enqueued</th>
            <th>Duration</th>
            <th>Where</th>
            <th>Message</th>
            <th>Log</th>
          </tr>
        </thead>
        <tbody>
          {list.map((run) => (
            <ScheduledAgentRunRow key={run.id} agentId={props.agentId} run={run} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScheduledAgentRunRow(props: { agentId: string; run: ScheduledAgentRun }) {
  const { run } = props;
  const [logOpen, setLogOpen] = useState(false);
  const duration = (() => {
    if (run.status === "queued") {
      const seconds = Math.floor((Date.now() - new Date(run.enqueuedAt).getTime()) / 1000);
      return `waiting ${seconds}s`;
    }
    if (run.startedAt && run.endedAt) {
      const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
      return `${(ms / 1000).toFixed(1)}s`;
    }
    if (run.startedAt) {
      const ms = Date.now() - new Date(run.startedAt).getTime();
      return `running ${(ms / 1000).toFixed(0)}s`;
    }
    return "—";
  })();
  const where = run.backgroundSessionId
    ? `bg ${run.backgroundSessionId.slice(0, 10)}`
    : run.workspaceId
      ? `ws ${run.workspaceId.slice(0, 10)}`
      : "—";
  const canViewLog = !!run.logFilePath && run.status !== "queued";
  return (
    <>
      <tr className={`scheduled-agent-history-row ${run.status}`}>
        <td>
          <span className={`scheduled-agent-status-badge ${run.status}`}>{formatLabel(run.status)}</span>
        </td>
        <td>{new Date(run.enqueuedAt).toLocaleString()}</td>
        <td>{duration}</td>
        <td>{where}</td>
        <td>{run.message ?? "—"}</td>
        <td>
          {canViewLog ? (
            <Button type="button" variant="ghost" onClick={() => setLogOpen((v) => !v)}>
              {logOpen ? "Hide" : "View"}
            </Button>
          ) : (
            "—"
          )}
        </td>
      </tr>
      {logOpen && canViewLog ? (
        <tr className="scheduled-agent-history-log-row">
          <td colSpan={6}>
            <ScheduledAgentRunLog agentId={props.agentId} runId={run.id} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ScheduledAgentRunLog(props: { agentId: string; runId: string }) {
  const log = useQuery<{ content: string; truncated: boolean; bytesRead: number; nextOffset: number }>({
    queryKey: ["scheduled-agent-run-log", props.agentId, props.runId],
    queryFn: () =>
      api<{ content: string; truncated: boolean; bytesRead: number; nextOffset: number }>(
        `/api/scheduled-agents/${props.agentId}/runs/${props.runId}/log?maxBytes=65536`,
      ),
  });
  if (log.isLoading) return <pre className="scheduled-agent-run-log">Loading…</pre>;
  if (log.error) return <pre className="scheduled-agent-run-log error">Error: {String(log.error)}</pre>;
  return (
    <pre className="scheduled-agent-run-log">
      {log.data?.content ?? ""}
      {log.data?.truncated ? "\n— truncated; fetch more via offset —" : ""}
    </pre>
  );
}
