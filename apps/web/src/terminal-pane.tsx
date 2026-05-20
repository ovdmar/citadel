import type { AgentSession, Workspace, WorkspaceDiff } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { Archive, RefreshCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

const TERMINAL_THEME = {
  background: "#0b1220",
  foreground: "#e2e8f0",
  cursor: "#38bdf8",
  cursorAccent: "#0b1220",
  selectionBackground: "rgba(56, 189, 248, 0.32)",
  black: "#1e293b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#67e8f9",
  white: "#e2e8f0",
  brightBlack: "#475569",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#a5f3fc",
  brightWhite: "#f8fafc",
} as const;

export function TerminalPane(props: { session: AgentSession }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "closed">("connecting");
  const [exitReason, setExitReason] = useState<string | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    setExitReason(null);
    setSnapshotError(null);
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.15,
      letterSpacing: 0,
      scrollback: 8000,
      allowProposedApi: true,
      theme: TERMINAL_THEME,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(containerRef.current);
    // Initial fit after layout settles so xterm picks the actual container size.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {
        // ignore until the next observer tick
      }
    });
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${protocol}://${window.location.host}/terminal/${props.session.id}`);
    const sendTerminalMessage = (message: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };
    let pendingResize: number | null = null;
    const resize = () => {
      if (pendingResize !== null) cancelAnimationFrame(pendingResize);
      pendingResize = requestAnimationFrame(() => {
        pendingResize = null;
        try {
          fit.fit();
        } catch {
          return;
        }
        sendTerminalMessage({ type: "resize", cols: terminal.cols, rows: terminal.rows });
      });
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
    let everConnected = false;
    socket.addEventListener("open", () => {
      everConnected = true;
      setState("connected");
      resize();
      terminal.focus();
    });
    socket.addEventListener("error", () => {
      if (!everConnected) {
        terminal.write(
          "\r\n\x1b[31m[connection refused — the tmux session may have exited before the cockpit could attach]\x1b[0m\r\n",
        );
      }
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string };
      if (message.type === "output" && typeof message.data === "string") {
        terminal.write(message.data);
      } else if (message.type === "outputChunk" && typeof message.data === "string") {
        terminal.write(message.data);
      } else if (message.type === "exit" && typeof message.data === "string") {
        setExitReason(message.data);
        terminal.write(`\r\n\x1b[33m[session exited: ${message.data}]\x1b[0m\r\n`);
      } else if (message.type === "error" && typeof message.data === "string") {
        setSnapshotError(message.data);
        terminal.write(`\r\n\x1b[31m[snapshot error: ${message.data}]\x1b[0m\r\n`);
      }
    });
    socket.addEventListener("close", () => setState("closed"));
    return () => {
      if (pendingResize !== null) cancelAnimationFrame(pendingResize);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.element?.removeEventListener("paste", pasteListener);
      socket.close();
      terminal.dispose();
    };
  }, [props.session.id]);

  return (
    <div className="terminal-shell">
      <div className="terminal-status" aria-live="polite">
        <span>{props.session.displayName}</span>
        <span className="terminal-status-flex" />
        {snapshotError ? <em className="terminal-status-error">snapshot: {snapshotError}</em> : null}
        {exitReason ? <em className="terminal-status-exit">exited · {exitReason}</em> : null}
        <strong className={`terminal-status-state ${state}`}>{state}</strong>
      </div>
      <div ref={containerRef} className="terminal-surface" data-testid="terminal-surface" />
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
  if (diff.isLoading) return <div className="empty">Reading git status</div>;
  if (diff.isError) {
    return (
      <div className="diff-empty">
        <div className="empty">Diff is unavailable</div>
        <Button type="button" variant="secondary" onClick={() => diff.refetch()} disabled={diff.isFetching}>
          <RefreshCcw size={15} /> Retry
        </Button>
      </div>
    );
  }
  if (diff.data?.clean) {
    return (
      <div className="diff-empty">
        <div className="empty">Workspace is clean</div>
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
        <span className="diff-add">+{diff.data?.addedLines ?? 0}</span>
        <span className="diff-del">-{diff.data?.deletedLines ?? 0}</span>
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
