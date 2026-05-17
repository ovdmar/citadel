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
import { useMutation, useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Archive, Play, RefreshCcw } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

export function ProviderSummary(props: { repo: Repo; workspace: Workspace | null; providerHealth: ProviderHealth[] }) {
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
  return (
    <div className="provider-stack">
      {!githubAvailable && githubHealth ? (
        <HealthRow provider={{ ...githubHealth, displayName: "GitHub unavailable" }} />
      ) : null}
      {vc ? (
        <HealthTile
          title={vc.currentBranch || props.repo.defaultBranch}
          status={vc.status}
          detail={vc.pullRequest ? `PR #${vc.pullRequest.number}` : "No active PR"}
          note={vc.pullRequest?.title ?? vc.reason}
        />
      ) : null}
      {props.workspace?.issueKey && !jiraAvailable && jiraHealth ? (
        <HealthRow provider={{ ...jiraHealth, displayName: `${props.workspace.issueKey} unavailable` }} />
      ) : null}
      {issue ? (
        <HealthTile
          title={issue.key}
          status={issue.status}
          detail={issue.issueStatus || formatLabel(issue.status)}
          note={issue.summary ?? issue.reason}
        >
          {issue.transitions.length ? (
            <div className="inline-actions">
              {issue.transitions.slice(0, 4).map((candidate) => (
                <Button
                  key={candidate.id}
                  type="button"
                  variant="secondary"
                  disabled={transition.isPending || issue.status !== "healthy" || !jiraAvailable}
                  onClick={() => transition.mutate(candidate.id)}
                >
                  {candidate.toStatus}
                </Button>
              ))}
            </div>
          ) : null}
        </HealthTile>
      ) : null}
      {ci ? (
        <HealthTile
          title="Checks"
          status={ci.status}
          detail={ci.runs[0] ? `${ci.runs[0].name}: ${formatLabel(ci.runs[0].status)}` : formatLabel(ci.status)}
          note={ci.runs[0]?.conclusion ? formatLabel(ci.runs[0].conclusion) : ci.reason}
        />
      ) : null}
      {!vc && !issue && !ci ? (
        <div className="empty compact">Provider details are unavailable for this workspace</div>
      ) : null}
    </div>
  );
}

export function HealthRow(props: { provider: ProviderHealth }) {
  return (
    <div className={`health ${props.provider.status}`}>
      <strong>{props.provider.displayName}</strong>
      <span>{formatLabel(props.provider.status)}</span>
      {props.provider.reason ? <p>{props.provider.reason}</p> : null}
    </div>
  );
}

export function RepoForm() {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const mutation = useMutation({
    mutationFn: () =>
      api("/api/repos", { method: "POST", body: JSON.stringify({ rootPath, name: name || undefined }) }),
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
      <Button type="submit" disabled={!rootPath || mutation.isPending}>
        Register repo
      </Button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

export function WorkspaceForm(props: { repo: Repo }) {
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
      <Button type="submit" disabled={!name || mutation.isPending}>
        Create workspace
      </Button>
      {mutation.error ? <p>{String(mutation.error)}</p> : null}
    </form>
  );
}

export function RuntimeLauncher(props: { workspace: Workspace; runtimes: AgentRuntime[] }) {
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
      <Button
        type="button"
        disabled={!runtime || runtime.health !== "healthy" || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        <Play size={15} /> Start session
      </Button>
      {runtime?.healthReason ? <p>{runtime.healthReason}</p> : null}
    </div>
  );
}

export function DiffPanel(props: { workspace: Workspace }) {
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
        <Button type="button" variant="secondary" onClick={() => diff.refetch()} disabled={diff.isFetching}>
          <RefreshCcw size={15} /> Retry
        </Button>
      </div>
    );
  }
  if (diff.data?.clean) {
    return (
      <div className="diff-empty">
        <Empty text="Workspace is clean" />
        <div className="diff-actions">
          <Button type="button" variant="secondary" onClick={() => diff.refetch()} disabled={diff.isFetching}>
            <RefreshCcw size={15} /> Refresh
          </Button>
          <Button type="button" variant="secondary" onClick={() => archive.mutate()} disabled={archive.isPending}>
            <Archive size={15} /> Archive metadata
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="diff-panel">
      <div className="diff-toolbar">
        <span>{diff.data?.files.length ?? 0} changed files</span>
        {diff.data?.truncated ? <strong>Large diff bounded</strong> : null}
        <Button type="button" variant="secondary" onClick={() => diff.refetch()} disabled={diff.isFetching}>
          <RefreshCcw size={15} /> Refresh
        </Button>
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

export function TerminalPane(props: { session: AgentSession }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "closed">("connecting");
  useEffect(() => {
    if (!containerRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      scrollback: 8000,
      theme: { background: "#101318", foreground: "#f8fafc" },
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
    const inputDisposable = terminal.onData((data) => sendTerminalMessage({ type: "input", data }));
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
      if (message.type === "outputChunk" && typeof message.data === "string") terminal.write(message.data);
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

function HealthTile(props: {
  title: string;
  status: string;
  detail: string;
  note?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className={`health ${props.status}`}>
      <strong>{props.title}</strong>
      <span>{props.detail}</span>
      {props.note ? <p>{props.note}</p> : null}
      {props.children}
    </div>
  );
}

function Empty(props: { text: string }) {
  return <div className="empty">{props.text}</div>;
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
