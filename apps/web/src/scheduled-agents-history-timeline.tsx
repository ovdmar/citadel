import type { ScheduledAgent, ScheduledAgentRun } from "@citadel/contracts";
import { useQueries, useQuery } from "@tanstack/react-query";
import { ArrowRightCircle, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

// Global history timeline — flattens every scheduled agent's runs into a
// single reverse-chronological list. Past one-shots live HERE because the
// Upcoming tab filters them out (they will never fire again).
export function ScheduledAgentsHistoryTimeline(props: {
  agents: ScheduledAgent[];
  onScheduleAgain: (agent: ScheduledAgent) => void;
}) {
  // useQueries lets each agent's per-run query cache independently so a slow
  // one doesn't block the others, and React Query dedupes by queryKey if the
  // same agent shows up twice (it shouldn't, but cheap safety).
  const runQueries = useQueries({
    queries: props.agents.map((agent) => ({
      queryKey: ["scheduled-agent-runs", agent.id],
      queryFn: () => api<{ runs: ScheduledAgentRun[] }>(`/api/scheduled-agents/${agent.id}/runs?limit=200`),
      refetchInterval: 10_000,
    })),
  });

  const agentsById = useMemo(() => {
    const map = new Map<string, ScheduledAgent>();
    for (const agent of props.agents) map.set(agent.id, agent);
    return map;
  }, [props.agents]);

  const rows = useMemo(() => {
    const flat: Array<{ run: ScheduledAgentRun; agent: ScheduledAgent }> = [];
    runQueries.forEach((query, index) => {
      const agent = props.agents[index];
      if (!agent || !query.data) return;
      for (const run of query.data.runs) flat.push({ run, agent });
    });
    flat.sort((a, b) => (a.run.enqueuedAt < b.run.enqueuedAt ? 1 : -1));
    return flat;
  }, [runQueries, props.agents]);

  const loading = runQueries.some((query) => query.isLoading);
  const errored = runQueries.find((query) => query.isError);

  if (!props.agents.length) {
    return <div className="sched-timeline empty">No scheduled agents have ever been created — history is empty.</div>;
  }
  if (loading && !rows.length) {
    return <div className="sched-timeline loading">Loading run history…</div>;
  }
  if (!rows.length) {
    return (
      <div className="sched-timeline empty">
        No runs yet — scheduled agents will show their history here as they fire.
      </div>
    );
  }

  return (
    <div className="sched-timeline">
      {errored ? (
        <p className="form-error">
          One or more agents failed to load: {String((errored.error as Error)?.message ?? "see console")}
        </p>
      ) : null}
      {rows.map(({ run, agent }) => (
        <TimelineRow
          key={`${agent.id}:${run.id}`}
          run={run}
          agent={agent}
          onScheduleAgain={() => props.onScheduleAgain(agent)}
          agentsById={agentsById}
        />
      ))}
    </div>
  );
}

function TimelineRow(props: {
  run: ScheduledAgentRun;
  agent: ScheduledAgent;
  agentsById: Map<string, ScheduledAgent>;
  onScheduleAgain: () => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  const { run, agent } = props;
  const duration = computeDuration(run);
  const canViewLog = !!run.logFilePath && run.status !== "queued";
  const isOneShot = agent.scheduleType === "once";

  return (
    <div className={`sched-timeline-row ${run.status}`}>
      <div className="sched-timeline-time">
        <strong>{new Date(run.enqueuedAt).toLocaleString()}</strong>
        <small>{duration}</small>
      </div>
      <div className="sched-timeline-body">
        <div className="sched-timeline-headline">
          <span className={`scheduled-agent-status-badge ${run.status}`}>{formatLabel(run.status)}</span>
          <strong className="sched-timeline-agent">{agent.name}</strong>
          <span className="sched-timeline-kind">{isOneShot ? "one-shot" : "recurring"}</span>
        </div>
        {run.message ? <p className="sched-timeline-message">{run.message}</p> : null}
        <div className="sched-timeline-actions">
          {canViewLog ? (
            <Button type="button" variant="ghost" onClick={() => setLogOpen((value) => !value)}>
              <FileText size={12} /> {logOpen ? "Hide log" : "View log"}
            </Button>
          ) : null}
          {isOneShot && run.status !== "queued" ? (
            <Button type="button" variant="secondary" onClick={props.onScheduleAgain}>
              <ArrowRightCircle size={12} /> Schedule again
            </Button>
          ) : null}
        </div>
        {logOpen && canViewLog ? <TimelineRunLog agentId={agent.id} runId={run.id} /> : null}
      </div>
    </div>
  );
}

function TimelineRunLog(props: { agentId: string; runId: string }) {
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

function computeDuration(run: ScheduledAgentRun): string {
  if (run.status === "queued") return "waiting";
  if (run.startedAt && run.endedAt) {
    const ms = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (run.startedAt) {
    const ms = Date.now() - new Date(run.startedAt).getTime();
    return `running ${(ms / 1000).toFixed(0)}s`;
  }
  return "—";
}
