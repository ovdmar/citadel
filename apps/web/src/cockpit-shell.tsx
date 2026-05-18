import type { ActivityEvent, AgentSession, Operation, ProviderHealth, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Command, RefreshCcw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

export type StageMode = "terminal" | "diff" | "review";

export function ReconcileButton() {
  const mutation = useMutation({
    mutationFn: () =>
      api<{ sessions: number; workspaces: number; repos: number }>("/api/reconcile", { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const result = mutation.data;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      aria-label="Reconcile local state"
      title={
        result
          ? `Reconciled: ${result.sessions} sessions, ${result.workspaces} workspaces, ${result.repos} repos`
          : "Reconcile local state with disk"
      }
    >
      <RefreshCcw size={15} />
    </Button>
  );
}

export function SessionStopButton(props: { session: AgentSession | null }) {
  const stop = useMutation({
    mutationFn: () => api(`/api/agent-sessions/${props.session?.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  if (!props.session) return null;
  const disabled = stop.isPending || ["stopped", "failed", "orphaned"].includes(props.session.status);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Stop session"
      title="Stop session"
      onClick={() => stop.mutate()}
      disabled={disabled}
    >
      <Square size={14} />
    </Button>
  );
}

type CommandAction = {
  id: string;
  label: string;
  hint: string;
  run: () => void;
};

export function CommandPalette(props: {
  workspaces: Workspace[];
  sessions: AgentSession[];
  activeWorkspace: Workspace | null;
  activeSession: AgentSession | null;
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
  onMode: (mode: StageMode) => void;
  onNavigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const reconcile = useMutation({
    mutationFn: () => api("/api/reconcile", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const refreshWorkspace = useMutation({
    mutationFn: () => api(`/api/workspaces/${props.activeWorkspace?.id}/refresh`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", props.activeWorkspace?.id] }),
  });
  const stopSession = useMutation({
    mutationFn: () => api(`/api/agent-sessions/${props.activeSession?.id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const close = props.onClose;
  const actions: CommandAction[] = [];
  if (props.activeWorkspace)
    actions.push({
      id: "refresh-workspace",
      label: "Refresh workspace providers",
      hint: props.activeWorkspace.name,
      run: () => {
        refreshWorkspace.mutate();
        close();
      },
    });
  if (props.activeSession && !["stopped", "failed", "orphaned"].includes(props.activeSession.status))
    actions.push({
      id: "stop-session",
      label: `Stop session ${props.activeSession.displayName}`,
      hint: props.activeSession.runtimeId,
      run: () => {
        stopSession.mutate();
        close();
      },
    });
  actions.push(
    {
      id: "reconcile",
      label: "Reconcile local state",
      hint: "kill ghost repos & orphan sessions",
      run: () => {
        reconcile.mutate();
        close();
      },
    },
    {
      id: "settings",
      label: "Open Settings",
      hint: "providers, hooks, runtimes",
      run: () => {
        props.onNavigate("/settings");
        close();
      },
    },
    {
      id: "operations",
      label: "Open Operations",
      hint: "logs, retry, cancel",
      run: () => {
        props.onNavigate("/operations");
        close();
      },
    },
    {
      id: "onboarding",
      label: "Open Onboarding wizard",
      hint: "first-run flow",
      run: () => {
        props.onNavigate("/onboarding");
        close();
      },
    },
  );
  const lowerQuery = query.toLowerCase();
  const matches = props.workspaces
    .filter((workspace) =>
      `${workspace.name} ${workspace.branch} ${workspace.issueKey ?? ""}`.toLowerCase().includes(lowerQuery),
    )
    .slice(0, 8);
  const filteredActions = actions.filter(
    (action) => !lowerQuery || `${action.label} ${action.hint}`.toLowerCase().includes(lowerQuery),
  );
  return (
    <div className="command-backdrop" onMouseDown={props.onClose}>
      <dialog className="command-palette" aria-label="Quick open" open onMouseDown={(event) => event.stopPropagation()}>
        <label className="quick-search command-search">
          <Command size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Switch workspace or run command"
          />
        </label>
        <div className="command-list">
          {matches.map((workspace) => (
            <button key={workspace.id} type="button" onClick={() => props.onSelect(workspace)}>
              <strong>{workspace.name}</strong>
              <span>{workspace.branch}</span>
              <em>{props.sessions.filter((session) => session.workspaceId === workspace.id).length} sessions</em>
            </button>
          ))}
          {(["terminal", "diff", "review"] as StageMode[]).map((mode) => (
            <button key={mode} type="button" onClick={() => props.onMode(mode)}>
              <strong>Open {formatLabel(mode)}</strong>
              <span>Stage focus</span>
            </button>
          ))}
          {filteredActions.map((action) => (
            <button key={action.id} type="button" onClick={action.run}>
              <strong>{action.label}</strong>
              <span>{action.hint}</span>
            </button>
          ))}
        </div>
      </dialog>
    </div>
  );
}

export function MobileMonitor(props: {
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  providerHealth: ProviderHealth[];
  activity: ActivityEvent[];
}) {
  const reconcile = useMutation({
    mutationFn: () => api("/api/reconcile", { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const blockedWorkspaces = props.workspaces.filter((workspace) => {
    const attention = readinessForWorkspace(workspace, {
      sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
      operations: props.operations.filter((operation) => operation.workspaceId === workspace.id),
      summary: undefined,
    });
    return ["blocked", "dirty"].includes(attention.section);
  });
  const failedOps = props.operations.filter((operation) => operation.status === "failed").slice(0, 5);
  return (
    <div className="mobile-monitor-panel">
      <section>
        <h2>Health</h2>
        <ul>
          {props.providerHealth.map((provider) => (
            <li key={provider.id} className={`health-line ${provider.status}`}>
              <strong>{provider.displayName}</strong>
              <span>{provider.status}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>Needs attention</h2>
        {blockedWorkspaces.length ? (
          <ul>
            {blockedWorkspaces.slice(0, 6).map((workspace) => (
              <li key={workspace.id}>
                <strong>{workspace.name}</strong>
                <span>{workspace.branch}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty compact">All workspaces clean</div>
        )}
      </section>
      <section>
        <h2>Failed operations</h2>
        {failedOps.length ? (
          <ul>
            {failedOps.map((operation) => (
              <li key={operation.id}>
                <strong>{operation.type}</strong>
                <small>{operation.error ?? operation.message ?? ""}</small>
              </li>
            ))}
          </ul>
        ) : (
          <div className="empty compact">No failed operations</div>
        )}
      </section>
      <section>
        <h2>Quick actions</h2>
        <div className="stack-form">
          <Button type="button" variant="secondary" onClick={() => reconcile.mutate()} disabled={reconcile.isPending}>
            Reconcile state
          </Button>
          <Link to="/operations" className="settings-link">
            View operations
          </Link>
          <Link to="/settings" className="settings-link">
            Open settings
          </Link>
        </div>
      </section>
    </div>
  );
}
