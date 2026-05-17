import type { AgentRuntime, AgentSession, ProviderHealth, Repo, Workspace, WorkspaceDiff } from "@citadel/contracts";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Cable,
  GitBranch,
  HeartPulse,
  Moon,
  Play,
  Plus,
  Settings,
  Sun,
  TerminalSquare,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type StateResponse = {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: unknown[];
  activity: { id: string; message: string; createdAt: string; type: string }[];
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  mcp: { enabled: boolean; resources: string[]; tools: string[] };
};

const queryClient = new QueryClient();

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

const rootRoute = createRootRoute({
  component: () => <Shell />,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Cockpit,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsView,
});

const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute, settingsRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function Shell() {
  const [theme, setTheme] = useState(() => localStorage.getItem("citadel.theme") || "system");
  useEffect(() => {
    localStorage.setItem("citadel.theme", theme);
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">Citadel</div>
        <nav>
          <Link to="/" activeProps={{ className: "active" }}>
            <Boxes size={17} /> Workspaces
          </Link>
          <Link to="/settings" activeProps={{ className: "active" }}>
            <Settings size={17} /> Settings
          </Link>
        </nav>
        <div className="theme">
          <button type="button" aria-label="Light theme" onClick={() => setTheme("light")}>
            <Sun size={16} />
          </button>
          <button type="button" aria-label="Dark theme" onClick={() => setTheme("dark")}>
            <Moon size={16} />
          </button>
        </div>
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

function useStateQuery() {
  return useQuery({
    queryKey: ["state"],
    queryFn: () => api<StateResponse>("/api/state"),
    refetchInterval: 5000,
  });
}

function Cockpit() {
  const state = useStateQuery();
  useEventRefresh();
  const data = state.data;
  const selectedWorkspace = data?.workspaces[0];
  const selectedRepo = data?.repos[0];

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Operations</h1>
          <p>Local repos, workspaces, agent sessions, provider health, and terminal access.</p>
        </div>
      </header>

      <section className="metrics">
        <Metric icon={<GitBranch />} label="Repos" value={data?.repos.length ?? 0} />
        <Metric icon={<Boxes />} label="Workspaces" value={data?.workspaces.length ?? 0} />
        <Metric icon={<TerminalSquare />} label="Sessions" value={data?.sessions.length ?? 0} />
        <Metric icon={<Cable />} label="MCP" value={data?.mcp.enabled ? "On" : "Off"} />
      </section>

      <div className="grid">
        <section className="panel wide">
          <PanelTitle icon={<Boxes />} title="Workspace Board" />
          {state.isLoading ? <Empty text="Loading local state" /> : null}
          {data?.workspaces.length === 0 ? <Empty text="No workspaces registered yet" /> : null}
          <div className="workspace-list">
            {data?.workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                sessions={data.sessions.filter((session) => session.workspaceId === workspace.id)}
              />
            ))}
          </div>
        </section>

        <section className="panel">
          <PanelTitle icon={<HeartPulse />} title="Provider Health" />
          {data?.providerHealth.map((provider) => (
            <HealthRow key={provider.id} provider={provider} />
          ))}
        </section>

        <section className="panel">
          <PanelTitle icon={<Plus />} title="Create" />
          <RepoForm />
          {selectedRepo ? (
            <WorkspaceForm repo={selectedRepo} />
          ) : (
            <Empty text="Register a repo before creating workspaces" />
          )}
        </section>

        <section className="panel">
          <PanelTitle icon={<Play />} title="Runtime Launch" />
          {selectedWorkspace ? (
            <RuntimeLauncher workspace={selectedWorkspace} runtimes={data?.runtimes ?? []} />
          ) : (
            <Empty text="Select or create a workspace" />
          )}
        </section>

        <section className="panel">
          <PanelTitle icon={<GitBranch />} title="Diff" />
          {selectedWorkspace ? <DiffPanel workspace={selectedWorkspace} /> : <Empty text="No workspace selected" />}
        </section>

        <section className="panel wide">
          <PanelTitle icon={<Activity />} title="Activity" />
          {data?.activity.slice(0, 12).map((event) => (
            <div className="activity-row" key={event.id}>
              <span>{event.type}</span>
              <p>{event.message}</p>
              <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

function Metric(props: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="metric">
      {props.icon}
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function PanelTitle(props: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {props.icon}
      <h2>{props.title}</h2>
    </div>
  );
}

function Empty(props: { text: string }) {
  return <div className="empty">{props.text}</div>;
}

function WorkspaceRow(props: { workspace: Workspace; sessions: AgentSession[] }) {
  return (
    <div className="workspace-row">
      <div>
        <strong>{props.workspace.name}</strong>
        <span>{props.workspace.branch}</span>
      </div>
      <div className="badges">
        <span>{props.workspace.lifecycle}</span>
        <span>{props.workspace.section}</span>
        <span>{props.sessions.length} sessions</span>
      </div>
    </div>
  );
}

function HealthRow(props: { provider: ProviderHealth }) {
  return (
    <div className={`health ${props.provider.status}`}>
      <strong>{props.provider.displayName}</strong>
      <span>{props.provider.status}</span>
      {props.provider.reason ? <p>{props.provider.reason}</p> : null}
    </div>
  );
}

function RepoForm() {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/repos", {
        method: "POST",
        body: JSON.stringify({ rootPath, name: name || undefined }),
      }),
    onSuccess: () => {
      setRootPath("");
      setName("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        Repo path
        <input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="/home/me/project" />
      </label>
      <label>
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Optional display name" />
      </label>
      <button type="submit" disabled={!rootPath || mutation.isPending}>
        Register repo
      </button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

function WorkspaceForm(props: { repo: Repo }) {
  const [name, setName] = useState("");
  const [source, setSource] = useState<"scratch" | "issue">("scratch");
  const [issueKey, setIssueKey] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          repoId: props.repo.id,
          name,
          source,
          issueKey: issueKey || undefined,
          issueTitle: issueTitle || undefined,
        }),
      }),
    onSuccess: () => {
      setName("");
      setIssueKey("");
      setIssueTitle("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  return (
    <form
      className="stack-form"
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate();
      }}
    >
      <label>
        Workspace
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="short-task-name" />
      </label>
      <label>
        Source
        <select value={source} onChange={(event) => setSource(event.target.value as "scratch" | "issue")}>
          <option value="scratch">Scratch</option>
          <option value="issue">Issue</option>
        </select>
      </label>
      {source === "issue" ? (
        <>
          <label>
            Issue key
            <input value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="MS-123" />
          </label>
          <label>
            Issue title
            <input
              value={issueTitle}
              onChange={(event) => setIssueTitle(event.target.value)}
              placeholder="Optional title"
            />
          </label>
        </>
      ) : null}
      <button type="submit" disabled={!name || mutation.isPending}>
        Create workspace
      </button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

function RuntimeLauncher(props: { workspace: Workspace; runtimes: AgentRuntime[] }) {
  const [runtimeId, setRuntimeId] = useState(props.runtimes[0]?.id ?? "shell");
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({ workspaceId: props.workspace.id, runtimeId }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const runtime = useMemo(
    () => props.runtimes.find((candidate) => candidate.id === runtimeId),
    [props.runtimes, runtimeId],
  );
  return (
    <div className="runtime-launcher">
      <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
        {props.runtimes.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.displayName} - {candidate.health}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!runtime || runtime.health !== "healthy" || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <Play size={15} /> Start
      </button>
      {runtime?.healthReason ? <p>{runtime.healthReason}</p> : null}
    </div>
  );
}

function DiffPanel(props: { workspace: Workspace }) {
  const diff = useQuery({
    queryKey: ["diff", props.workspace.id],
    queryFn: () => api<WorkspaceDiff>(`/api/workspaces/${props.workspace.id}/diff`),
  });
  const archive = useMutation({
    mutationFn: () => api(`/api/workspaces/${props.workspace.id}?archiveOnly=true`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  if (diff.isLoading) return <Empty text="Reading git status" />;
  if (diff.data?.clean) {
    return (
      <div className="runtime-launcher">
        <Empty text="Workspace is clean" />
        <button type="button" onClick={() => archive.mutate()} disabled={archive.isPending}>
          Archive metadata
        </button>
      </div>
    );
  }
  return (
    <div className="diff-list">
      {diff.data?.files.map((file) => (
        <details key={file.path} className="diff-file">
          <summary>
            <span>{file.status}</span>
            <strong>{file.path}</strong>
            {file.truncated ? <em>truncated</em> : null}
          </summary>
          <pre>{file.binary ? "Binary file" : file.diff || "No textual diff available"}</pre>
        </details>
      ))}
    </div>
  );
}

function SettingsView() {
  const state = useStateQuery();
  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Settings</h1>
          <p>Config, providers, runtimes, MCP, and local-first health.</p>
        </div>
      </header>
      <div className="grid">
        <section className="panel">
          <PanelTitle icon={<TerminalSquare />} title="Runtimes" />
          {state.data?.runtimes.map((runtime) => (
            <HealthRow
              key={runtime.id}
              provider={{
                id: runtime.id,
                displayName: runtime.displayName,
                kind: "usage",
                status: runtime.health,
                reason: runtime.healthReason,
                checkedAt: new Date().toISOString(),
              }}
            />
          ))}
        </section>
        <section className="panel">
          <PanelTitle icon={<Cable />} title="MCP" />
          <div className="empty">{state.data?.mcp.enabled ? "Enabled for local/internal use" : "Disabled"}</div>
        </section>
      </div>
    </div>
  );
}

function useEventRefresh() {
  useEffect(() => {
    const events = new EventSource("/events");
    events.onmessage = () => queryClient.invalidateQueries({ queryKey: ["state"] });
    events.addEventListener("workspace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("agent.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    return () => events.close();
  }, []);
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </React.StrictMode>,
);
