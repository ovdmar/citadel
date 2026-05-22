import type { Operation, Repo, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Ban, RefreshCcw, Repeat } from "lucide-react";
import { useMemo, useState } from "react";
import { api, queryClient } from "../api.js";
import { useStateQuery } from "../app-state.js";
import { Button } from "../components/ui/button.js";
import { formatLabel } from "../labels.js";

type FilterStatus = "all" | "running" | "succeeded" | "failed" | "cancelled";

export function OperationsView() {
  const state = useStateQuery();
  const operations = state.data?.operations ?? [];
  const repos = state.data?.repos ?? [];
  const workspaces = state.data?.workspaces ?? [];

  const [filter, setFilter] = useState<FilterStatus>("all");
  const [typeFilter, setTypeFilter] = useState("");

  const types = useMemo(() => Array.from(new Set(operations.map((op) => op.type))).sort(), [operations]);

  // Roll-up counters drive the filter chips. Recompute against the *unfiltered*
  // list so chips don't flicker when the user narrows.
  const totals = useMemo(() => {
    const t = { all: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 } as Record<FilterStatus, number>;
    for (const op of operations) {
      t.all += 1;
      if (op.status === "running" || op.status === "queued") t.running += 1;
      else if (op.status === "succeeded") t.succeeded += 1;
      else if (op.status === "failed") t.failed += 1;
      else if (op.status === "cancelled") t.cancelled += 1;
    }
    return t;
  }, [operations]);

  const filtered = useMemo(() => {
    return operations.filter((op) => {
      if (typeFilter && op.type !== typeFilter) return false;
      if (filter === "all") return true;
      if (filter === "running") return op.status === "running" || op.status === "queued";
      return op.status === filter;
    });
  }, [operations, filter, typeFilter]);

  return (
    <div className="page operations-page">
      <header className="header">
        <div>
          <h1>Operations</h1>
          <p>Audit trail of long-running and side-effectful work. Retry or cancel where safe.</p>
        </div>
        <div className="settings-header-actions">
          <Link to="/" className="settings-link">
            <ArrowLeft size={14} /> Cockpit
          </Link>
          <Link to="/settings" className="settings-link">
            Settings
          </Link>
        </div>
      </header>
      <div className="operations-filter-bar">
        <div className="operations-filter-chips" role="tablist" aria-label="Status filter">
          {(Object.entries(totals) as Array<[FilterStatus, number]>).map(([key, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={filter === key}
              className={`operations-filter-chip ${filter === key ? "active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {formatLabel(key)} <span className="operations-filter-count">{count}</span>
            </button>
          ))}
        </div>
        <label className="operations-filter-type">
          Type
          <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}>
            <option value="">All</option>
            {types.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
      </div>
      {filtered.length === 0 ? (
        <div className="empty">No operations match the current filter.</div>
      ) : (
        <div className="operations-list">
          {filtered.map((operation) => (
            <OperationRow key={operation.id} operation={operation} repos={repos} workspaces={workspaces} />
          ))}
        </div>
      )}
    </div>
  );
}

function OperationRow(props: { operation: Operation; repos: Repo[]; workspaces: Workspace[] }) {
  const { operation, repos, workspaces } = props;
  const repo = operation.repoId ? repos.find((candidate) => candidate.id === operation.repoId) : null;
  const workspace = operation.workspaceId
    ? workspaces.find((candidate) => candidate.id === operation.workspaceId)
    : null;
  const retry = useMutation({
    mutationFn: () => api(`/api/operations/${operation.id}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/api/operations/${operation.id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const duration = computeDuration(operation);
  const lastLog = operation.logs[operation.logs.length - 1];

  return (
    <details className={`operation-row status-${operation.status}`} data-testid={`operation-${operation.id}`}>
      <summary>
        <strong>{prettyOperationType(operation.type)}</strong>
        <span className={`status status-${operation.status}`}>{formatLabel(operation.status)}</span>
        {repo ? <span className="operation-chip">{repo.name}</span> : null}
        {workspace ? <span className="operation-chip">{workspace.name}</span> : null}
        <span className="operation-time">
          {new Date(operation.updatedAt).toLocaleTimeString()}
          {duration ? ` · ${duration}` : ""}
        </span>
        {operation.error ? <span className="error">{operation.error}</span> : null}
      </summary>
      <div className="operation-detail">
        <dl className="operation-meta-grid">
          <div>
            <dt>Started</dt>
            <dd>{new Date(operation.createdAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{new Date(operation.updatedAt).toLocaleString()}</dd>
          </div>
          {duration ? (
            <div>
              <dt>Duration</dt>
              <dd>{duration}</dd>
            </div>
          ) : null}
          <div>
            <dt>Progress</dt>
            <dd>{operation.progress}%</dd>
          </div>
          {repo ? (
            <div>
              <dt>Repository</dt>
              <dd>{repo.name}</dd>
            </div>
          ) : null}
          {workspace ? (
            <div>
              <dt>Workspace</dt>
              <dd>
                <Link to="/" search={{ workspace: workspace.id }}>
                  {workspace.name}
                </Link>
              </dd>
            </div>
          ) : null}
        </dl>
        {operation.message ? <p className="operation-message">{operation.message}</p> : null}
        {lastLog && !operation.logs.length ? null : null}
        {operation.logs.length ? (
          <details className="operation-logs-wrap">
            <summary>
              {operation.logs.length} log {operation.logs.length === 1 ? "entry" : "entries"}
              {lastLog ? ` · latest: ${lastLog.message}` : ""}
            </summary>
            <pre className="operation-logs">
              {operation.logs
                .map((entry) => `[${new Date(entry.at).toLocaleTimeString()}] (${entry.level}) ${entry.message}`)
                .join("\n")}
            </pre>
          </details>
        ) : (
          <small className="operation-logs-empty">No log entries recorded for this operation.</small>
        )}
        <div className="operation-actions">
          {operation.retriable ? (
            <Button type="button" variant="secondary" onClick={() => retry.mutate()} disabled={retry.isPending}>
              <Repeat size={13} /> Retry
            </Button>
          ) : null}
          {["queued", "running"].includes(operation.status) ? (
            <Button type="button" variant="secondary" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              <Ban size={13} /> Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            title="Refresh state"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["state"] })}
          >
            <RefreshCcw size={14} />
          </Button>
        </div>
      </div>
    </details>
  );
}

function computeDuration(operation: Operation): string | null {
  const start = Date.parse(operation.createdAt);
  const end =
    operation.status === "running" || operation.status === "queued" ? Date.now() : Date.parse(operation.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

// Convert "workspace.create" → "Workspace · Create" for the audit header.
function prettyOperationType(type: string): string {
  return type
    .split(".")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).replace(/-/g, " "))
    .join(" · ");
}
