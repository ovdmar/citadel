import type { AgentSession } from "@citadel/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "./api.js";
import { Button } from "./components/ui/button.js";
import { type ResolvedTheme, useResolvedTheme } from "./use-resolved-theme.js";

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
const TERMINAL_CLIENT_VERSION = "shortcut-bridge-v2";

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
  /**
   * Force a respawn. Optional `theme` overrides the pane's own `themeRef` —
   * used by the live-re-theme orchestrator so the new theme reaches ensure()
   * without waiting for the React effect that syncs the ref. When called
   * without a theme (manual tab reload), the pane uses its current ref value
   * and the call is NOT subject to the orchestrator's `lastKnownTheme`
   * idempotency check — manual reload always respawns.
   */
  reload: (theme?: ResolvedTheme) => void;
  /** Theme the underlying ttyd was most recently spawned with (post successful
   * ensure). Null until the first ensure resolves. Read by the orchestrator
   * to skip no-op respawns. */
  lastKnownTheme: ResolvedTheme | null;
  // Focus the iframe element programmatically. The ttyd payload is
  // cross-origin (separate port) so this only focuses the iframe itself —
  // xterm keyboard capture still requires one click inside the terminal
  // area. See spec B.2 §Center Stage Sessions / select-focuses-terminal.
  focusIframe: () => void;
  recoverIfDisconnected: () => boolean;
};

const REGISTRY = new Map<string, TerminalHandle>();
const FRAME_WINDOWS = new Map<string, Window>();
const LISTENERS = new Set<(id: string) => void>();

function publish(id: string, handle: TerminalHandle | null, frameWindow: Window | null = null) {
  if (handle) {
    REGISTRY.set(id, handle);
    if (frameWindow) FRAME_WINDOWS.set(id, frameWindow);
    else FRAME_WINDOWS.delete(id);
  } else {
    REGISTRY.delete(id);
    FRAME_WINDOWS.delete(id);
  }
  for (const listener of LISTENERS) listener(id);
}

export function getTerminalHandle(sessionId: string): TerminalHandle | undefined {
  return REGISTRY.get(sessionId);
}

export function listTerminalHandles(): Array<[string, TerminalHandle]> {
  return Array.from(REGISTRY.entries());
}

export function subscribeTerminalHandle(listener: (sessionId: string) => void): () => void {
  LISTENERS.add(listener);
  return () => LISTENERS.delete(listener);
}

export function isRegisteredTerminalMessageSource(
  source: MessageEventSource | null,
  sessionId: string | null | undefined,
): boolean {
  if (source) {
    for (const frameWindow of FRAME_WINDOWS.values()) {
      if (source === frameWindow) return true;
    }
  }
  return Boolean(sessionId && REGISTRY.has(sessionId));
}

// Focus the iframe of an active session. No-op when:
//   - sessionId is null/undefined (workspace has no active session)
//   - no handle is registered (session not yet mounted)
//   - document.activeElement is a text input or contenteditable (don't steal
//     focus while the user is typing — e.g. inline workspace-title rename).
// The cross-origin ttyd iframe may not always allow the parent to drive xterm
// keyboard focus, but focusing both the frame element and WindowProxy gives
// Chrome/ttyd the best chance of making workspace selection ready for typing.
export function focusActiveTerminal(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const handle = REGISTRY.get(sessionId);
  if (!handle) return;
  const active = typeof document !== "undefined" ? document.activeElement : null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
  if (active instanceof HTMLElement && active.isContentEditable) return;
  handle.focusIframe();
}

export function TerminalPane(props: { session: AgentSession }) {
  const sessionId = props.session.id;
  const theme = useResolvedTheme();
  // Capture the theme in a ref so ensure() reads the current value without
  // re-creating its identity on every theme change. Live auto-respawn on
  // theme change is the live-re-theme orchestrator's job (re-theme-
  // orchestrator.ts) — it iterates registered handles, staggers spawns, and
  // coalesces rapid toggles to guard against the cleanup-storm regression
  // class. Manual tab-action reload still uses ensure({ force: true }).
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<EnsureError | null>(null);
  const [pending, setPending] = useState(true);
  const [iframeKey, setIframeKey] = useState(0);
  const requestSeqRef = useRef(0);
  // Track the theme the underlying ttyd was last spawned with, so the live
  // re-theme orchestrator can skip no-op respawns. Updated only AFTER a
  // successful ensure() resolves with the requested theme.
  const lastKnownThemeRef = useRef<ResolvedTheme | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const httpErrorRecoveryRef = useRef(false);

  const ensure = useCallback(
    async (options: { bumpFrame?: boolean; force?: boolean; theme?: ResolvedTheme } = {}) => {
      const seq = ++requestSeqRef.current;
      setPending(true);
      setError(null);
      const requestedTheme = options.theme ?? themeRef.current;
      try {
        const params = new URLSearchParams({ theme: requestedTheme });
        if (options.force) params.set("force", "true");
        const response = await api<EnsureResponse>(`/api/agent-sessions/${sessionId}/terminal?${params.toString()}`, {
          method: "POST",
        });
        if (requestSeqRef.current !== seq) return;
        setUrl(response.terminal.url);
        setError(null);
        lastKnownThemeRef.current = requestedTheme;
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

  // Reload re-runs ensure() with force=true so the daemon respawns ttyd with
  // the requested theme. ttyd bakes the xterm palette at spawn time, so this
  // is the only way to repaint a live session after a theme toggle. It also
  // self-heals stale entries from daemon restarts / orphan kills. Bumping
  // the iframe key forces React to remount even if the URL is the same — the
  // underlying ttyd process is new, so reconnecting is required.
  //
  // The optional `theme` arg is the orchestrator's escape hatch: passing it
  // explicitly skips the `themeRef` read so the new theme reaches ensure()
  // even if React hasn't yet replayed the effect that updates the ref.
  const reload = useCallback(
    (theme?: ResolvedTheme) => {
      void ensure({ bumpFrame: true, force: true, ...(theme ? { theme } : {}) });
    },
    [ensure],
  );

  // Focus the iframe element first, then ask the nested browsing context to
  // focus itself. The try/catch keeps cross-origin focus restrictions from
  // breaking workspace selection; preventScroll keeps the cockpit layout
  // stable when selecting a workspace far down the nav.
  const focusIframe = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    iframe.focus({ preventScroll: true });
    try {
      iframe.contentWindow?.focus();
    } catch {
      // Cross-origin focus restrictions are browser-dependent.
    }
  }, []);

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

  // Publish the live URL + reload/focus/recover callbacks so nav selection,
  // tab actions, shortcut filtering, and the live re-theme orchestrator can
  // drive state owned by TerminalPane.
  // `theme` is intentionally tracked so publish() re-fires when the resolved
  // theme changes and exposes the latest lastKnownThemeRef.current snapshot.
  // biome-ignore lint/correctness/useExhaustiveDependencies: iframeKey remounts the iframe, which changes contentWindow even when URL/callbacks are stable.
  useEffect(() => {
    publish(
      sessionId,
      { url, reload, lastKnownTheme: lastKnownThemeRef.current, focusIframe, recoverIfDisconnected },
      iframeRef.current?.contentWindow ?? null,
    );
    return () => publish(sessionId, null);
  }, [sessionId, url, reload, focusIframe, recoverIfDisconnected, iframeKey, theme]);
  return (
    <div className="terminal-shell">
      <div className="terminal-surface terminal-surface-iframe">
        {url ? (
          <iframe
            ref={iframeRef}
            key={`${sessionId}-${iframeKey}`}
            className="terminal-iframe"
            src={terminalIframeSrc(url)}
            title={`Terminal ${props.session.displayName}`}
            allow="clipboard-read; clipboard-write"
            // tabIndex makes the iframe a programmatic-focus target without
            // adding it to the natural tab order.
            tabIndex={-1}
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

export function terminalIframeSrc(url: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}citadelClient=${encodeURIComponent(TERMINAL_CLIENT_VERSION)}`;
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
