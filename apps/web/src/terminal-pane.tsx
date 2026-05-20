import type { AgentSession } from "@citadel/contracts";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import { Button } from "./components/ui/button.js";

type EnsureResponse = {
  terminal: {
    key: string;
    url: string;
    basePath: string;
    port: number;
    tmuxSession: string;
    worktreePath: string | null;
    startedAt: string;
  };
};

type EnsureError = {
  code: string;
  detail: string;
};

const RUNBOOK_URL = "/docs/operations/terminal-runbook";

export function TerminalPane(props: { session: AgentSession }) {
  const sessionId = props.session.id;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<EnsureError | null>(null);
  const [pending, setPending] = useState(true);
  const [iframeKey, setIframeKey] = useState(0);
  const requestSeqRef = useRef(0);

  const ensure = useCallback(async () => {
    const seq = ++requestSeqRef.current;
    setPending(true);
    setError(null);
    try {
      const response = await api<EnsureResponse>(`/api/agent-sessions/${sessionId}/terminal`, {
        method: "POST",
      });
      if (requestSeqRef.current !== seq) return;
      setUrl(response.terminal.url);
      setError(null);
    } catch (raw) {
      if (requestSeqRef.current !== seq) return;
      setUrl(null);
      setError(parseEnsureError(raw instanceof Error ? raw : new Error(String(raw))));
    } finally {
      if (requestSeqRef.current === seq) setPending(false);
    }
  }, [sessionId]);

  useEffect(() => {
    setUrl(null);
    setError(null);
    setIframeKey(0);
    void ensure();
  }, [ensure]);

  const retry = useCallback(() => {
    void ensure();
  }, [ensure]);

  const reload = useCallback(() => setIframeKey((value) => value + 1), []);

  return (
    <div className="terminal-shell">
      <div className="terminal-status" aria-live="polite">
        <span>{props.session.displayName}</span>
        <span className="terminal-status-flex" />
        {url ? (
          <>
            <a
              className="terminal-status-link"
              href={url}
              target="_blank"
              rel="noreferrer"
              title="Open in standalone tab"
            >
              <ExternalLink size={11} /> open
            </a>
            <Button type="button" variant="ghost" size="icon" title="Reload terminal frame" onClick={reload}>
              <RefreshCw size={12} />
            </Button>
          </>
        ) : null}
        <strong className={`terminal-status-state ${url ? "connected" : error ? "closed" : "connecting"}`}>
          {url ? "ttyd" : error ? "error" : "starting"}
        </strong>
      </div>
      <div className="terminal-surface terminal-surface-iframe">
        {url ? (
          <iframe
            key={`${sessionId}-${iframeKey}`}
            className="terminal-iframe"
            src={url}
            title={`Terminal ${props.session.displayName}`}
            allow="clipboard-read; clipboard-write"
          />
        ) : error ? (
          <TerminalErrorState error={error} onRetry={retry} retrying={pending} />
        ) : (
          <div className="terminal-pending">Starting ttyd…</div>
        )}
      </div>
    </div>
  );
}

function TerminalErrorState(props: { error: EnsureError; onRetry: () => void; retrying: boolean }) {
  const { code, detail } = props.error;
  const guidance = guidanceFor(code);
  return (
    <div className="terminal-error-state" role="alert">
      <h3>Terminal unavailable</h3>
      <p className="terminal-error-code">{code}</p>
      {detail ? <p className="terminal-error-detail">{detail}</p> : null}
      <p className="terminal-error-guidance">{guidance}</p>
      <div className="terminal-error-actions">
        <Button type="button" onClick={props.onRetry} disabled={props.retrying}>
          {props.retrying ? "Retrying…" : "Retry"}
        </Button>
        <a className="terminal-error-link" href="/settings" title="Open Citadel settings">
          Open settings
        </a>
        <a className="terminal-error-link" href={RUNBOOK_URL} title="Terminal runbook">
          Runbook
        </a>
      </div>
    </div>
  );
}

function parseEnsureError(error: Error): EnsureError {
  if (error instanceof ApiError) {
    return { code: error.message || "terminal_unavailable", detail: error.detail ?? "" };
  }
  return { code: "terminal_unavailable", detail: error.message ?? "" };
}

function guidanceFor(code: string) {
  switch (code) {
    case "ttyd_missing":
      return "ttyd binary not found. Install ttyd or set TTYD_BIN to its absolute path in Citadel settings, then retry.";
    case "no_free_port":
      return "Citadel could not allocate a port in the ttyd range. Stop unused terminals or widen CITADEL_TTYD_PORT_BASE..MAX.";
    case "ttyd_start_timeout":
      return "ttyd was spawned but never began listening. Check daemon logs and that the shell/runtime command exits cleanly.";
    case "tmux_session_missing":
      return "The tmux session this terminal would attach to no longer exists. Restart the agent session or reconcile.";
    case "session_not_found":
      return "This Citadel session is not registered. Refresh or recreate it from the cockpit.";
    case "spawn_failed":
      return "ttyd failed to spawn. Verify TTYD_BIN, file permissions, and shell binary configuration.";
    default:
      return "Open the terminal runbook below for diagnostic steps.";
  }
}
