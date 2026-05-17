import type {
  AgentRuntime,
  AgentSession,
  CiProviderSummary,
  IssueTrackerSummary,
  IssueTransitionActionResult,
  ProviderHealth,
  Repo,
  VersionControlSummary,
  Workspace,
  WorkspaceDiff,
} from "@citadel/contracts";
import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import {
  Activity,
  Boxes,
  Cable,
  GitBranch,
  HeartPulse,
  Moon,
  Play,
  Plus,
  RefreshCcw,
  Settings,
  Sun,
  TerminalSquare,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import { api, queryClient } from "./api.js";
import { ConfigForm } from "./config-form.js";
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
  const selectedSession = selectedWorkspace
    ? data?.sessions.find((session) => session.workspaceId === selectedWorkspace.id)
    : undefined;

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
          {selectedRepo ? (
            <ProviderSummary
              repo={selectedRepo}
              workspace={selectedWorkspace ?? null}
              providerHealth={data?.providerHealth ?? []}
            />
          ) : null}
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
          <PanelTitle icon={<TerminalSquare />} title="Terminal" />
          {selectedSession ? (
            <TerminalPane session={selectedSession} />
          ) : (
            <Empty text="Start a runtime session to open a terminal" />
          )}
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

function ProviderSummary(props: { repo: Repo; workspace: Workspace | null; providerHealth: ProviderHealth[] }) {
  const githubHealth = props.providerHealth.find((provider) => provider.id === "github-gh");
  const jiraHealth = props.providerHealth.find((provider) => provider.id === "jira-jtk");
  const githubAvailable = githubHealth?.status === "healthy";
  const jiraAvailable = jiraHealth?.status === "healthy";
  const summary = useQuery({
    queryKey: ["provider-summary", props.repo.id],
    enabled: githubAvailable,
    queryFn: () => api<{ versionControl: VersionControlSummary }>(`/api/repos/${props.repo.id}/provider-summary`),
  });
  const issueSummary = useQuery({
    queryKey: ["issue-summary", props.workspace?.id],
    enabled: Boolean(props.workspace?.issueKey) && jiraAvailable,
    queryFn: () => api<{ issueTracker: IssueTrackerSummary }>(`/api/workspaces/${props.workspace?.id}/issue-summary`),
  });
  const ciSummary = useQuery({
    queryKey: ["ci-runs", props.repo.id],
    enabled: githubAvailable,
    queryFn: () => api<{ ci: CiProviderSummary }>(`/api/repos/${props.repo.id}/ci-runs`),
  });
  const transition = useMutation({
    mutationFn: (transitionId: string) =>
      api<{ result: IssueTransitionActionResult }>(`/api/workspaces/${props.workspace?.id}/issue-transition`, {
        method: "POST",
        body: JSON.stringify({ transition: transitionId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["issue-summary", props.workspace?.id] });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  const vc = summary.data?.versionControl;
  const issue = issueSummary.data?.issueTracker;
  const ci = ciSummary.data?.ci;
  if (!vc && !issue && !ci && githubAvailable && (!props.workspace?.issueKey || jiraAvailable)) return null;
  return (
    <>
      {!githubAvailable && githubHealth ? (
        <div className={`health ${githubHealth.status}`}>
          <strong>GitHub</strong>
          <span>Unavailable</span>
          {githubHealth.reason ? <p>{githubHealth.reason}</p> : null}
        </div>
      ) : null}
      {vc ? (
        <div className={`health ${vc.status}`}>
          <strong>{vc.currentBranch || props.repo.defaultBranch}</strong>
          <span>{vc.pullRequest ? `PR #${vc.pullRequest.number}` : "No active PR"}</span>
          {vc.pullRequest ? <p>{vc.pullRequest.title}</p> : null}
          {vc.reason ? <p>{vc.reason}</p> : null}
        </div>
      ) : null}
      {props.workspace?.issueKey && !jiraAvailable && jiraHealth ? (
        <div className={`health ${jiraHealth.status}`}>
          <strong>{props.workspace.issueKey}</strong>
          <span>Issue tracker unavailable</span>
          {jiraHealth.reason ? <p>{jiraHealth.reason}</p> : null}
        </div>
      ) : null}
      {issue ? (
        <div className={`health ${issue.status}`}>
          <strong>{issue.key}</strong>
          <span>{issue.issueStatus || issue.status}</span>
          {issue.summary ? <p>{issue.summary}</p> : null}
          {issue.transitions.length > 0 ? (
            <div className="inline-actions">
              {issue.transitions.slice(0, 4).map((candidate) => (
                <button
                  type="button"
                  key={candidate.id}
                  disabled={transition.isPending || issue.status !== "healthy" || !jiraAvailable}
                  onClick={() => transition.mutate(candidate.id)}
                >
                  {candidate.toStatus}
                </button>
              ))}
            </div>
          ) : null}
          {issue.reason ? <p>{issue.reason}</p> : null}
          {transition.error ? <p>{String(transition.error)}</p> : null}
        </div>
      ) : null}
      {ci ? (
        <div className={`health ${ci.status}`}>
          <strong>Checks</strong>
          <span>{ci.runs[0] ? `${ci.runs[0].name}: ${ci.runs[0].status}` : ci.status}</span>
          {ci.runs[0]?.conclusion ? <p>{ci.runs[0].conclusion}</p> : null}
          {ci.reason ? <p>{ci.reason}</p> : null}
        </div>
      ) : null}
    </>
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
  if (diff.isError) {
    return (
      <div className="diff-empty">
        <Empty text="Diff is unavailable" />
        <button type="button" onClick={() => diff.refetch()} disabled={diff.isFetching}>
          <RefreshCcw size={15} /> Retry
        </button>
      </div>
    );
  }
  if (diff.data?.clean) {
    return (
      <div className="diff-empty">
        <Empty text="Workspace is clean" />
        <div className="diff-actions">
          <button type="button" onClick={() => diff.refetch()} disabled={diff.isFetching}>
            <RefreshCcw size={15} /> Refresh
          </button>
          <button type="button" onClick={() => archive.mutate()} disabled={archive.isPending}>
            Archive metadata
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <span>{diff.data?.files.length ?? 0} changed files</span>
        {diff.data?.truncated ? <strong>Large diff bounded</strong> : null}
        <button type="button" onClick={() => diff.refetch()} disabled={diff.isFetching}>
          <RefreshCcw size={15} /> Refresh
        </button>
      </div>
      <div className="diff-list">
        {diff.data?.files.map((file, index) => (
          <details key={file.path} className="diff-file" open={index < 2}>
            <summary>
              <span className="diff-state">{formatDiffStatus(file.status)}</span>
              <strong>{file.path}</strong>
              {file.binary ? <em>Binary</em> : null}
              {file.truncated ? <em>Truncated</em> : null}
            </summary>
            <DiffBody file={file} />
          </details>
        ))}
      </div>
    </div>
  );
}

function DiffBody(props: { file: WorkspaceDiff["files"][number] }) {
  if (props.file.binary) return <div className="diff-message">Binary file changed. Text preview is not available.</div>;
  if (!props.file.diff && props.file.status.includes("D")) {
    return <div className="diff-message">File was deleted. No text preview is available.</div>;
  }
  if (!props.file.diff) return <div className="diff-message">No textual diff available.</div>;
  return (
    <pre className="diff-code">
      {props.file.diff.split("\n").map((line, index) => (
        <span key={`${index}-${line.slice(0, 16)}`} className={diffLineClass(line)}>
          {line || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function formatDiffStatus(status: string) {
  if (status.includes("R")) return "Renamed";
  if (status === "??") return "Untracked";
  if (status.includes("D")) return "Deleted";
  if (status.includes("A")) return "Added";
  if (status.includes("M")) return "Modified";
  return "Changed";
}

function diffLineClass(line: string) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "diff-line diff-line-add";
  if (line.startsWith("-") && !line.startsWith("---")) return "diff-line diff-line-remove";
  if (line.startsWith("@@")) return "diff-line diff-line-hunk";
  return "diff-line";
}

function TerminalPane(props: { session: AgentSession }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "closed">("connecting");

  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: {
        background: "#101318",
        foreground: "#f8fafc",
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    fit.fit();

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/terminal/${props.session.id}`);
    const sendTerminalMessage = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    const resize = () => {
      fit.fit();
      sendTerminalMessage({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(containerRef.current);
    const inputDisposable = terminal.onData((data) => {
      sendTerminalMessage({ type: "input", data });
    });
    const pasteListener = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain");
      if (!text) return;
      event.preventDefault();
      sendTerminalMessage({ type: "paste", data: text });
    };
    terminal.element?.addEventListener("paste", pasteListener);
    socket.addEventListener("open", () => {
      setState("connected");
      resize();
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string };
      if (message.type === "output" && typeof message.data === "string") {
        terminal.reset();
        terminal.write(message.data);
      }
    });
    socket.addEventListener("close", () => setState("closed"));
    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.element?.removeEventListener("paste", pasteListener);
      socket.close();
      terminal.dispose();
    };
  }, [props.session.id]);

  return (
    <div className="terminal-shell">
      <div className="terminal-status">
        <span>{props.session.displayName}</span>
        <strong>{state}</strong>
      </div>
      <div ref={containerRef} className="terminal-surface" data-testid="terminal-surface" />
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
        <section className="panel wide">
          <PanelTitle icon={<Settings />} title="Local Config" />
          <ConfigForm />
        </section>
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
