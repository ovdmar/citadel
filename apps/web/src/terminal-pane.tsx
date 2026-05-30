import type { AgentSession } from "@citadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import { Button } from "./components/ui/button.js";
import { useResolvedTheme } from "./use-resolved-theme.js";

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

/**
 * Per-session handle used by Stage tabs to drive a live terminal (reload the
 * ttyd frame, open it in a standalone tab). The in-pane status bar was
 * removed; these affordances live on the tab now and need access to state
 * owned by TerminalPane, so we publish a tiny registry on the window.
 *
 * Keyed by session id. TerminalPane registers on mount and clears on unmount.
 */
export type TerminalHandle = {
  url: string | null;
  reload: () => void;
  recoverIfDisconnected: () => boolean;
};

const REGISTRY = new Map<string, TerminalHandle>();
const LISTENERS = new Set<(id: string) => void>();

function publish(id: string, handle: TerminalHandle | null) {
  if (handle) REGISTRY.set(id, handle);
  else REGISTRY.delete(id);
  for (const listener of LISTENERS) listener(id);
}

export function getTerminalHandle(sessionId: string): TerminalHandle | undefined {
  return REGISTRY.get(sessionId);
}

export function subscribeTerminalHandle(listener: (sessionId: string) => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

export function TerminalPane(props: { session: AgentSession }) {
  const sessionId = props.session.id;
  const theme = useResolvedTheme();
  // Capture the theme in a ref so ensure() reads the current value without
  // re-creating its identity on every theme change. We deliberately do not
  // auto-respawn on theme change — ttyd bakes its palette at spawn time, so
  // active sessions pick up a new palette only through the explicit reload
  // affordance.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<EnsureError | null>(null);
  const [pending, setPending] = useState(true);
  const [iframeKey, setIframeKey] = useState(0);
  const requestSeqRef = useRef(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const httpErrorRecoveryRef = useRef(false);

  const ensure = useCallback(
    async (options: { bumpFrame?: boolean; force?: boolean } = {}) => {
      const seq = ++requestSeqRef.current;
      setPending(true);
      setError(null);
      try {
        const params = new URLSearchParams({ theme: themeRef.current });
        if (options.force) params.set("force", "true");
        const response = await api<EnsureResponse>(`/api/agent-sessions/${sessionId}/terminal?${params.toString()}`, {
          method: "POST",
        });
        if (requestSeqRef.current !== seq) return;
        setUrl(response.terminal.url);
        setError(null);
        httpErrorRecoveryRef.current = false;
        if (options.bumpFrame) setIframeKey((value) => value + 1);
      } catch (raw) {
        if (requestSeqRef.current !== seq) return;
        setUrl(null);
        setError(parseEnsureError(raw instanceof Error ? raw : new Error(String(raw))));
      } finally {
        if (requestSeqRef.current === seq) setPending(false);
      }
    },
    [sessionId],
  );

  // Some classes of failure (tmux session vanished after daemon restart,
  // ttyd reaped by an orphan-killer) are transient: a single retry usually
  // reattaches. Auto-retry once with a short backoff so the user does not see
  // a flash of "Terminal unavailable" before manual reload.
  const retryOnceRef = useRef(false);
  useEffect(() => {
    if (!error) {
      retryOnceRef.current = false;
      return;
    }
    if (retryOnceRef.current) return;
    if (!["tmux_session_missing", "terminal_unavailable", "spawn_failed", "ttyd_start_timeout"].includes(error.code))
      return;
    retryOnceRef.current = true;
    const timer = window.setTimeout(() => {
      void ensure({ bumpFrame: true });
    }, 600);
    return () => window.clearTimeout(timer);
  }, [error, ensure]);

  useEffect(() => {
    setUrl(null);
    setError(null);
    setIframeKey(0);
    void ensure();
  }, [ensure]);

  const retry = useCallback(() => {
    void ensure();
  }, [ensure]);

  // Reload re-runs ensure() with force=true so the daemon respawns ttyd. It
  // also self-heals stale entries from daemon restarts / orphan kills.
  // Bumping the iframe key forces React to remount even if the URL is the
  // same — the underlying ttyd process is new, so reconnecting is required.
  const reload = useCallback(() => {
    void ensure({ bumpFrame: true, force: true });
  }, [ensure]);

  const recoverIfTerminalHttpError = useCallback(() => {
    if (!isTtydHttpErrorPageVisible(iframeRef.current)) {
      httpErrorRecoveryRef.current = false;
      return false;
    }
    if (httpErrorRecoveryRef.current) return true;
    httpErrorRecoveryRef.current = true;
    recordTerminalClientEvent(sessionId, "iframe.http-error");
    void ensure({ bumpFrame: true, force: true });
    return true;
  }, [ensure, sessionId]);

  const recoverIfDisconnected = useCallback(() => {
    if (!isTtydReconnectPromptVisible(iframeRef.current)) return false;
    reload();
    return true;
  }, [reload]);

  // Publish the live URL + reload callback so the stage tab can drive them.
  // The status bar used to render these affordances inside the pane; that was
  // removed in favour of the tab actions, but the state still lives here.
  useEffect(() => {
    publish(sessionId, { url, reload, recoverIfDisconnected });
    return () => publish(sessionId, null);
  }, [sessionId, url, reload, recoverIfDisconnected]);
  return (
    <div className="terminal-shell">
      <div className="terminal-surface terminal-surface-iframe">
        {url ? (
          <iframe
            ref={iframeRef}
            key={`${sessionId}-${iframeKey}`}
            className="terminal-iframe"
            src={url}
            title={`Terminal ${props.session.displayName}`}
            allow="clipboard-read; clipboard-write"
            onLoad={recoverIfTerminalHttpError}
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

export function isTtydReconnectPromptVisible(iframe: HTMLIFrameElement | null): boolean {
  try {
    const doc = iframe?.contentDocument;
    const view = iframe?.contentWindow;
    if (!doc || !view) return false;

    const ttydOverlayCandidates = Array.from(doc.querySelectorAll(".xterm > div"));
    for (const element of ttydOverlayCandidates) {
      if (isHiddenElement(element, view)) continue;
      if (isReconnectPromptText(element.textContent ?? "")) return true;
    }

    for (const button of Array.from(doc.querySelectorAll("button"))) {
      if (isHiddenElement(button, view)) continue;
      if (/\breconnect\b/i.test(normalizeText(button.textContent ?? ""))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function isTtydHttpErrorPageVisible(iframe: HTMLIFrameElement | null): boolean {
  try {
    const doc = iframe?.contentDocument;
    if (!doc?.body) return false;
    if (doc.querySelector(".xterm")) return false;
    const text = normalizeText(doc.body.textContent ?? "").toLowerCase();
    const title = normalizeText(doc.title).toLowerCase();
    if (!text && !title) return false;
    return (
      text === "terminal_not_found" || text === "404 page not found" || text.startsWith("404") || title.includes("404")
    );
  } catch {
    return false;
  }
}

function isHiddenElement(element: Element, view: Window): boolean {
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return true;
  const opacity = Number.parseFloat(style.opacity || "1");
  return Number.isFinite(opacity) && opacity <= 0.05;
}

function isReconnectPromptText(value: string): boolean {
  const text = normalizeText(value);
  return /^press (?:⏎|enter|return) to reconnect$/i.test(text);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function recordTerminalClientEvent(sessionId: string, event: string) {
  fetch(`/api/agent-sessions/${encodeURIComponent(sessionId)}/terminal-client-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event,
      path: window.location.pathname,
      visibility: document.visibilityState,
    }),
    keepalive: true,
  }).catch(() => undefined);
}
