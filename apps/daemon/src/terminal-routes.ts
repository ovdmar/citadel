import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type TtydEntry, type TtydManager, TtydUnavailableError } from "@citadel/terminal";
import type express from "express";
import httpProxyImport from "http-proxy";
import { injectKeyShim, shouldInjectShim } from "./terminal-key-shim.js";

type HttpProxyModule = typeof httpProxyImport;
const httpProxy = (httpProxyImport as unknown as { default?: HttpProxyModule }).default ?? httpProxyImport;

const TERMINAL_PROXY_PREFIX = "/terminals";

type ResolvedSession = {
  sessionId: string;
  tabId: string | null;
  tmuxSession: string;
  worktreePath: string | null;
  runtimeId: string;
};

// Runtimes whose TUIs enable DEC mouse tracking and consume wheel events for
// in-app navigation (prompt history, etc.). For these we ask tmux to grab the
// wheel first and route it to copy-mode scrollback; otherwise the user can't
// reach terminal scrollback with the mouse. Claude Code is intentionally
// absent — it does not request mouse tracking, so its xterm-native wheel
// scroll works fine and stays untouched.
const MOUSE_GRABBING_RUNTIMES = new Set(["codex", "cursor-agent"]);

type Theme = "light" | "dark";

function parseTheme(value: unknown): Theme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

export function registerTerminalRoutes(input: {
  app: express.Express;
  server: http.Server;
  store: SqliteStore;
  ttyd: TtydManager;
  /** Where to persist per-session preferences (theme prefs sidecar). */
  dataDir: string;
  emit?: (type: string, payload: unknown) => void;
  /** Recreate the tmux session a terminal needs. Returns the live tmux name/id. */
  respawnTmux?: (session: AgentSession) => Promise<{ tmuxSessionName: string; tmuxSessionId: string } | null>;
  /** Relaunch the agent inside an existing pane (shell-first Restart endpoint). */
  restartAgent?: (session: AgentSession) => Promise<void>;
  /** In-memory map of recent operator-initiated terminations. Written by the
   * Restart endpoint and the user-action endpoint. The status-monitor reads
   * it on each tick to label `running → idle` transitions correctly. */
  recentUserAction?: Map<string, number>;
}) {
  const { app, server, store, ttyd } = input;
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: true,
    selfHandleResponse: true,
  });

  // ttyd's HTML page boots its WebSocket as soon as its bundle runs, so we
  // inject our keyboard-shortcut shim before any other <script> tag. For
  // everything else (JS bundles, CSS, fonts, 304/204 responses, gzipped
  // payloads, WebSocket frames) we just pipe the upstream response through
  // untouched — shouldInjectShim() gates the rewriting path so we never
  // corrupt compressed or bodyless responses.
  proxy.on("proxyRes", (proxyRes, _req, target) => {
    const httpRes = target as express.Response;
    httpRes.statusCode = proxyRes.statusCode ?? 200;
    const injectable = shouldInjectShim(proxyRes.headers, proxyRes.statusCode ?? 0);

    if (!injectable) {
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        httpRes.setHeader(name, value as string | string[]);
      }
      proxyRes.pipe(httpRes);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    proxyRes.on("end", () => {
      const original = Buffer.concat(chunks).toString("utf8");
      const modified = injectKeyShim(original);
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (value === undefined) continue;
        const lower = name.toLowerCase();
        if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") continue;
        httpRes.setHeader(name, value as string | string[]);
      }
      const buffer = Buffer.from(modified, "utf8");
      httpRes.setHeader("content-length", String(buffer.length));
      httpRes.end(buffer);
    });
    proxyRes.on("error", () => {
      try {
        httpRes.end();
      } catch {
        // ignore
      }
    });
  });

  // Remember the last theme the cockpit asked for, per sessionId. When a
  // websocket auto-reconnect (e.g. laptop wake) hits the daemon AFTER the
  // entry has been reaped — daemon restart, ttyd crash — `reviveProxyTarget`
  // calls ensure() without a request body, so without persistence we'd
  // default to "dark" and silently respawn ttyd with the wrong palette.
  //
  // The map is mirrored to a JSON sidecar so a daemon restart (which wipes
  // both the in-memory ttyd entries AND any in-process Map) doesn't lose the
  // user's theme selection across the revive path that runs on first
  // reconnect after restart.
  const themePreferences = new ThemePrefStore(input.dataDir);

  proxy.on("error", (error, req, target) => {
    const message = error instanceof Error ? error.message : "terminal_proxy_failed";
    if (process.env.CITADEL_DEBUG_TERMINAL_WS === "1") {
      const stamp = new Date().toISOString();
      console.log(`[ws] ${stamp} proxy-error`, { url: req?.url, message });
    }
    if (target && "headersSent" in target && typeof (target as express.Response).status === "function") {
      const response = target as express.Response;
      if (!response.headersSent) response.status(502).type("text/plain").send(message);
      return;
    }
    if (target && typeof (target as { destroy?: () => void }).destroy === "function") {
      try {
        (target as { destroy: () => void }).destroy();
      } catch {
        // ignore
      }
    }
  });

  if (process.env.CITADEL_DEBUG_TERMINAL_WS === "1") {
    const stamp = () => new Date().toISOString();
    proxy.on("open", (proxySocket: Duplex) => {
      console.log(`[ws] ${stamp()} upstream-open`);
      proxySocket.once("close", (hadError: boolean) => {
        console.log(`[ws] ${stamp()} upstream-close`, { hadError });
      });
      proxySocket.once("end", () => {
        console.log(`[ws] ${stamp()} upstream-end`);
      });
    });
    proxy.on("close", (_req, _socket, _head) => {
      console.log(`[ws] ${stamp()} proxy-ws-close`);
    });
  }

  const resolveSession = (sessionId: string): ResolvedSession | null => {
    const session = store.listSessions().find((candidate) => candidate.id === sessionId);
    if (!session?.tmuxSessionName) return null;
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    return {
      sessionId: session.id,
      tabId: session.tabId ?? null,
      tmuxSession: session.tmuxSessionName,
      worktreePath: workspace?.path ?? null,
      runtimeId: session.runtimeId,
    };
  };

  const resolveProxyTarget = (urlPath: string) => {
    const match = /^\/terminals\/([^/]+)(\/.*)?$/.exec(urlPath);
    if (!match) return null;
    const sessionId = decodeURIComponent(match[1] ?? "");
    const entry = ttyd.lookup(sessionId);
    if (!entry) return null;
    return { entry, target: `http://127.0.0.1:${entry.port}`, sessionId };
  };

  // Self-heal: if the ttyd entry for a known session is missing (daemon restart,
  // orphan kill, etc.) re-spawn it on demand so a stale iframe URL recovers
  // instead of dead-ending on terminal_not_found.
  //
  // Single-flighted per sessionId: the cockpit iframe boots both a HEAD
  // /terminals/<sid>/ HTTP request (for ttyd's HTML page) and a WebSocket
  // upgrade on /terminals/<sid>/ws within a few milliseconds. Without the
  // gate, BOTH branches enter the empty-manager fast path and each ends up
  // calling ttyd.ensure() → two ttyds attach to the same tmux session, one
  // ends up in the manager map, the other becomes a zombie. Re-using the
  // same in-flight promise here is what pins the invariant of one ttyd per
  // tab even before the ttyd-side per-tab lock has anything to deduplicate.
  const reviveInflight = new Map<string, Promise<{ entry: TtydEntry; target: string; sessionId: string } | null>>();
  const reviveProxyTarget = (urlPath: string) => {
    const match = /^\/terminals\/([^/]+)(\/.*)?$/.exec(urlPath);
    if (!match) return Promise.resolve(null);
    const sessionId = decodeURIComponent(match[1] ?? "");
    const existing = reviveInflight.get(sessionId);
    if (existing) return existing;
    const flight = (async () => {
      const session = resolveSession(sessionId);
      if (!session) return null;
      try {
        const entry = await ensureWithHeal(session, themePreferences.get(sessionId));
        input.emit?.("terminal.ready", { sessionId: session.sessionId, port: entry.port });
        return { entry, target: `http://127.0.0.1:${entry.port}`, sessionId };
      } catch {
        return null;
      }
    })().finally(() => {
      reviveInflight.delete(sessionId);
    });
    reviveInflight.set(sessionId, flight);
    return flight;
  };

  // Try ensure(); if tmux disappeared (system reboot, manual kill), call the
  // injected respawnTmux hook to bring the underlying tmux session back, then
  // retry. Returns null if no self-heal was possible.
  const ensureWithHeal = async (session: ResolvedSession, theme?: Theme, force?: boolean): Promise<TtydEntry> => {
    const enableTmuxMouse = MOUSE_GRABBING_RUNTIMES.has(session.runtimeId);
    const base = {
      key: session.sessionId,
      tabId: session.tabId,
      tmuxSession: session.tmuxSession,
      worktreePath: session.worktreePath,
      enableTmuxMouse,
    };
    const ensureArgs = {
      ...base,
      ...(theme ? { theme } : {}),
      ...(force ? { force: true } : {}),
    };
    try {
      return await ttyd.ensure(ensureArgs);
    } catch (error) {
      if (!(error instanceof TtydUnavailableError) || error.code !== "tmux_session_missing") throw error;
      if (!input.respawnTmux) throw error;
      const dbSession = store.listSessions().find((candidate) => candidate.id === session.sessionId);
      if (!dbSession) throw error;
      const respawn = await input.respawnTmux(dbSession);
      if (!respawn) throw error;
      const healArgs = {
        key: session.sessionId,
        tabId: session.tabId,
        tmuxSession: respawn.tmuxSessionName,
        worktreePath: session.worktreePath,
        enableTmuxMouse,
        ...(theme ? { theme } : {}),
        ...(force ? { force: true } : {}),
      };
      return await ttyd.ensure(healArgs);
    }
  };

  app.post("/api/agent-sessions/:sessionId/terminal", async (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    const session = resolveSession(sessionId);
    if (!session) return res.status(404).json({ error: "session_not_found" });
    const theme = parseTheme(req.query.theme) ?? parseTheme((req.body as { theme?: unknown } | undefined)?.theme);
    if (theme) themePreferences.set(sessionId, theme);
    const force =
      req.query.force === "true" ||
      req.query.force === "1" ||
      (req.body as { force?: unknown } | undefined)?.force === true;
    try {
      const entry = await ensureWithHeal(session, theme ?? themePreferences.get(sessionId), force);
      const url = `${TERMINAL_PROXY_PREFIX}/${encodeURIComponent(session.sessionId)}/`;
      input.emit?.("terminal.ready", { sessionId: session.sessionId, port: entry.port });
      return res.json({ terminal: terminalDto(entry, url) });
    } catch (error) {
      const status = error instanceof TtydUnavailableError ? 503 : 500;
      const code = error instanceof TtydUnavailableError ? error.code : "terminal_unavailable";
      const message = error instanceof Error ? error.message : "terminal_failed";
      return res.status(status).json({ error: code, detail: message });
    }
  });

  app.delete("/api/agent-sessions/:sessionId/terminal", (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    ttyd.release(sessionId);
    res.status(202).json({ released: true });
  });

  // Restart endpoint — relaunches the agent inside an existing pane.
  // Records recentUserAction BEFORE the mutation so the next status-monitor
  // tick sees the operator action and clears statusReason (rather than
  // labelling the resulting transition as `idle_after_unexpected_exit`).
  // Defensive check: if the agent is ALREADY running (pane foreground IS
  // the runtime binary, stale UI or race), return 409 instead of typing
  // `env … claude …` into the live TUI as a chat message.
  app.post("/api/agent-sessions/:sessionId/restart", async (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    const dbSession = store.listSessions().find((candidate) => candidate.id === sessionId);
    if (!dbSession) return res.status(404).json({ error: "session_not_found" });
    if (!input.restartAgent) return res.status(503).json({ error: "restart_not_wired" });
    input.recentUserAction?.set(sessionId, Date.now());
    try {
      await input.restartAgent(dbSession);
      input.emit?.("agent.updated", { workspaceId: dbSession.workspaceId, sessionId });
      return res.status(202).json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "restart_failed";
      // 409 for the defensive "agent_already_running" check; 500 for anything else.
      if (message === "agent_already_running") {
        return res.status(409).json({ error: "agent_already_running" });
      }
      return res.status(500).json({ error: "restart_failed", detail: message });
    }
  });

  // User-action endpoint — the terminal-key-shim (injected into ttyd's
  // iframe page) hits this with `{reason: 'ctrl_c'}` whenever the operator
  // types Ctrl+C inside the embedded terminal, in parallel with letting the
  // keystroke propagate to ttyd. Fire-and-forget: caller doesn't block on
  // the response. No rate-limit needed — the write is in-memory Map.set,
  // no DB or I/O.
  app.post("/api/agent-sessions/:sessionId/user-action", (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    input.recentUserAction?.set(sessionId, Date.now());
    res.status(204).end();
  });

  app.get("/api/terminals", (_req, res) => {
    res.json({
      terminals: ttyd
        .list()
        .map((entry) => terminalDto(entry, `${TERMINAL_PROXY_PREFIX}/${encodeURIComponent(entry.key)}/`)),
    });
  });

  // HTTP proxy: forward /terminals/:key/* to the matching ttyd instance.
  // We register at the root and inspect the path ourselves so the full `/terminals/...` prefix
  // is preserved when proxying (ttyd is launched with -b /terminals/<key> and expects the prefix).
  app.use(async (req, res, next) => {
    if (!req.url.startsWith(TERMINAL_PROXY_PREFIX)) return next();
    let resolved = resolveProxyTarget(req.url);
    if (!resolved) resolved = await reviveProxyTarget(req.url);
    if (!resolved) {
      res.status(404).type("text/plain").send("terminal_not_found");
      return;
    }
    // Force identity encoding so the HTML response stays plain text and our
    // shim injection can operate on the raw bytes. ttyd's other assets are
    // small enough that the bandwidth loss is negligible.
    req.headers["accept-encoding"] = "identity";
    // Auto-heal on connect-refused / reset: the daemon's `entries` map can
    // briefly hold a "live" record for a ttyd that bound the port but exited
    // immediately afterwards (e.g. its inner `bash -lc "tmux attach"` failed
    // because the tmux session wasn't ready yet, or two concurrent ensure()
    // calls raced). The user used to see "connect ECONNREFUSED 127.0.0.1:..."
    // and had to manually click reload. Release the stale entry and let
    // reviveProxyTarget spawn a fresh one, then retry the proxy once.
    proxy.web(req, res, { target: resolved.target }, async (error?: Error) => {
      if (res.headersSent) return;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ECONNREFUSED" || code === "ECONNRESET") {
        ttyd.release(resolved.sessionId);
        const revived = await reviveProxyTarget(req.url);
        if (revived) {
          proxy.web(req, res, { target: revived.target }, (err2?: Error) => {
            if (!res.headersSent) {
              res
                .status(502)
                .type("text/plain")
                .send(err2 instanceof Error ? err2.message : "terminal_proxy_failed");
            }
          });
          return;
        }
      }
      res
        .status(502)
        .type("text/plain")
        .send(error instanceof Error ? error.message : "terminal_proxy_failed");
    });
  });

  // WebSocket upgrade: ttyd opens /ws under the base path, so /terminals/:key/ws
  // lands here. Mirror the HTTP path's self-heal so a stale iframe that opens
  // a ws after the daemon restarted / ttyd was reaped picks up a freshly
  // spawned instance instead of hard-failing with terminal_not_found.
  // Lifecycle logging for terminal WS upgrades. Active only when
  // CITADEL_DEBUG_TERMINAL_WS=1 — captures which side closed (client vs
  // upstream ttyd), with reason, so "random terminal reload" reports can
  // be traced to a real cause (proxy timeout, ttyd ping miss, browser
  // navigation, etc).
  const debugWs = process.env.CITADEL_DEBUG_TERMINAL_WS === "1";
  const logWs = (...args: unknown[]) => {
    if (!debugWs) return;
    const stamp = new Date().toISOString();
    console.log(`[ws] ${stamp}`, ...args);
  };
  const instrumentSocket = (label: string, sessionId: string, socket: Duplex) => {
    if (!debugWs) return;
    socket.once("close", (hadError: boolean) => logWs(label, sessionId, "close", { hadError }));
    socket.once("end", () => logWs(label, sessionId, "end"));
    socket.once("error", (err: Error) => logWs(label, sessionId, "error", err.message));
  };

  const upgradeHandler = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const urlPath = request.url || "";
    if (!urlPath.startsWith(TERMINAL_PROXY_PREFIX)) return;
    const sessionMatch = /^\/terminals\/([^/]+)/.exec(urlPath);
    const sessionId = sessionMatch ? decodeURIComponent(sessionMatch[1] ?? "") : "?";
    logWs("upgrade", sessionId, { path: urlPath });
    instrumentSocket("client", sessionId, socket);
    const resolved = resolveProxyTarget(urlPath);
    if (!resolved) {
      // Hold the socket open while we try to revive ttyd. Browsers retry on
      // WS failure, but reviving avoids the surface-level error flash entirely.
      reviveProxyTarget(urlPath)
        .then((revived) => {
          if (!revived) {
            logWs("revive-failed", sessionId);
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
          }
          logWs("revived", sessionId, { target: revived.target });
          proxy.ws(request, socket, head, { target: revived.target });
        })
        .catch((err: Error) => {
          logWs("revive-error", sessionId, err.message);
          try {
            socket.destroy();
          } catch {
            // ignore
          }
        });
      return;
    }
    proxy.ws(request, socket, head, { target: resolved.target });
  };
  server.on("upgrade", upgradeHandler);

  server.on("close", () => {
    server.off("upgrade", upgradeHandler);
    // Intentionally do NOT signal ttyd children — they were spawned detached
    // so they outlive this daemon process and get re-adopted at next boot
    // (see discoverExistingTtyds() in apps/daemon/src/app.ts). shutdown()
    // just clears the in-memory map.
    ttyd.shutdown();
    proxy.close();
  });
}

// Disk-backed map of `sessionId → "light" | "dark"` for the terminal palette
// the cockpit last asked for. Survives daemon restarts so `reviveProxyTarget`
// (which fires when a websocket auto-reconnect arrives after the ttyd entry
// map has been wiped) can hand the user's chosen theme to ttyd.ensure()
// instead of falling back to "dark".
//
// File format is a flat JSON object — values are validated narrowly so a
// stray manual edit can't crash the daemon. Writes are best-effort and never
// throw: failing to persist a theme preference must not break terminal
// reconnects.
class ThemePrefStore {
  private readonly file: string;
  private readonly cache = new Map<string, Theme>();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "terminal-theme-prefs.json");
    try {
      if (fs.existsSync(this.file)) {
        const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
        for (const [key, value] of Object.entries(raw)) {
          const theme = parseTheme(value);
          if (theme) this.cache.set(key, theme);
        }
      }
    } catch {
      // Corrupt or unreadable — start clean. The first set() will rewrite the file.
    }
  }

  get(sessionId: string): Theme | undefined {
    return this.cache.get(sessionId);
  }

  set(sessionId: string, theme: Theme): void {
    if (this.cache.get(sessionId) === theme) return;
    this.cache.set(sessionId, theme);
    this.persist();
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const payload = JSON.stringify(Object.fromEntries(this.cache.entries()));
      fs.writeFileSync(this.file, payload, { mode: 0o600 });
    } catch {
      // Sidecar is a cache, not a source of truth — caller already has the
      // value in-memory for the current request. Drop the persistence error.
    }
  }
}

function terminalDto(entry: TtydEntry, url: string) {
  return {
    key: entry.key,
    url,
    basePath: entry.basePath,
    port: entry.port,
    tmuxSession: entry.tmuxSession,
    worktreePath: entry.worktreePath,
    startedAt: entry.startedAt,
    theme: entry.theme,
  };
}
