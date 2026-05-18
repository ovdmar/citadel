import type { Operation } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Ban, RefreshCcw, Repeat } from "lucide-react";
import { api, queryClient } from "../api.js";
import { useStateQuery } from "../app-state.js";
import { Button } from "../components/ui/button.js";
import { formatLabel } from "../labels.js";

export function OperationsView() {
  const state = useStateQuery();
  const operations = state.data?.operations ?? [];
  return (
    <div className="page operations-page">
      <header className="header">
        <div>
          <h1>Operations</h1>
          <p>Long-running and side-effectful work; retry or cancel where safe.</p>
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
      {operations.length === 0 ? (
        <div className="empty">No tracked operations yet.</div>
      ) : (
        <div className="operations-list">
          {operations.map((operation) => (
            <OperationRow key={operation.id} operation={operation} />
          ))}
        </div>
      )}
    </div>
  );
}

function OperationRow(props: { operation: Operation }) {
  const operation = props.operation;
  const retry = useMutation({
    mutationFn: () => api(`/api/operations/${operation.id}/retry`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const cancel = useMutation({
    mutationFn: () => api(`/api/operations/${operation.id}/cancel`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  return (
    <details className={`operation-row status-${operation.status}`} data-testid={`operation-${operation.id}`}>
      <summary>
        <strong>{operation.type}</strong>
        <span className={`status status-${operation.status}`}>{formatLabel(operation.status)}</span>
        <em>{new Date(operation.updatedAt).toLocaleTimeString()}</em>
        {operation.error ? <span className="error">{operation.error}</span> : null}
      </summary>
      <div className="operation-detail">
        <div className="operation-meta">
          <span>progress: {operation.progress}%</span>
          {operation.repoId ? <span>repo: {operation.repoId}</span> : null}
          {operation.workspaceId ? <span>workspace: {operation.workspaceId}</span> : null}
          <span>created: {new Date(operation.createdAt).toLocaleString()}</span>
        </div>
        {operation.message ? <p>{operation.message}</p> : null}
        {operation.logs.length ? (
          <pre className="operation-logs">
            {operation.logs.map((entry) => `[${entry.at}] (${entry.level}) ${entry.message}`).join("\n")}
          </pre>
        ) : (
          <small>No log entries recorded.</small>
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
            onClick={() => queryClient.invalidateQueries({ queryKey: ["state"] })}
          >
            <RefreshCcw size={14} />
          </Button>
        </div>
      </div>
    </details>
  );
}
