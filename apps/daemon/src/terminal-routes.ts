import type http from "node:http";
import type { Duplex } from "node:stream";
import type { AgentSession } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { type TtydEntry, type TtydManager, TtydUnavailableError } from "@citadel/terminal";
import type express from "express";
import httpProxyImport from "http-proxy";

type HttpProxyModule = typeof httpProxyImport;
const httpProxy = (httpProxyImport as unknown as { default?: HttpProxyModule }).default ?? httpProxyImport;

const TERMINAL_PROXY_PREFIX = "/terminals";

type ResolvedSession = {
  sessionId: string;
  tmuxSession: string;
  worktreePath: string | null;
};

export function registerTerminalRoutes(input: {
  app: express.Express;
  server: http.Server;
  store: SqliteStore;
  ttyd: TtydManager;
  emit?: (type: string, payload: unknown) => void;
  /** Recreate the tmux session a terminal needs. Returns the live tmux name/id. */
  respawnTmux?: (session: AgentSession) => Promise<{ tmuxSessionName: string; tmuxSessionId: string } | null>;
}) {
  const { app, server, store, ttyd } = input;
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: true });

  proxy.on("error", (error, _req, target) => {
    const message = error instanceof Error ? error.message : "terminal_proxy_failed";
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

  const resolveSession = (sessionId: string): ResolvedSession | null => {
    const session = store.listSessions().find((candidate) => candidate.id === sessionId);
    if (!session?.tmuxSessionName) return null;
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === session.workspaceId);
    return {
      sessionId: session.id,
      tmuxSession: session.tmuxSessionName,
      worktreePath: workspace?.path ?? null,
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
  const reviveProxyTarget = async (urlPath: string) => {
    const match = /^\/terminals\/([^/]+)(\/.*)?$/.exec(urlPath);
    if (!match) return null;
    const sessionId = decodeURIComponent(match[1] ?? "");
    const session = resolveSession(sessionId);
    if (!session) return null;
    try {
      const entry = await ensureWithHeal(session);
      input.emit?.("terminal.ready", { sessionId: session.sessionId, port: entry.port });
      return { entry, target: `http://127.0.0.1:${entry.port}`, sessionId };
    } catch {
      return null;
    }
  };

  // Try ensure(); if tmux disappeared (system reboot, manual kill), call the
  // injected respawnTmux hook to bring the underlying tmux session back, then
  // retry. Returns null if no self-heal was possible.
  const ensureWithHeal = async (session: ResolvedSession): Promise<TtydEntry> => {
    try {
      return await ttyd.ensure({
        key: session.sessionId,
        tmuxSession: session.tmuxSession,
        worktreePath: session.worktreePath,
      });
    } catch (error) {
      if (!(error instanceof TtydUnavailableError) || error.code !== "tmux_session_missing") throw error;
      if (!input.respawnTmux) throw error;
      const dbSession = store.listSessions().find((candidate) => candidate.id === session.sessionId);
      if (!dbSession) throw error;
      const respawn = await input.respawnTmux(dbSession);
      if (!respawn) throw error;
      return await ttyd.ensure({
        key: session.sessionId,
        tmuxSession: respawn.tmuxSessionName,
        worktreePath: session.worktreePath,
      });
    }
  };

  app.post("/api/agent-sessions/:sessionId/terminal", async (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    const session = resolveSession(sessionId);
    if (!session) return res.status(404).json({ error: "session_not_found" });
    try {
      const entry = await ensureWithHeal(session);
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
    proxy.web(req, res, { target: resolved.target }, (error?: Error) => {
      if (!res.headersSent) {
        res
          .status(502)
          .type("text/plain")
          .send(error instanceof Error ? error.message : "terminal_proxy_failed");
      }
    });
  });

  // WebSocket upgrade: ttyd opens /ws under the base path, so /terminals/:key/ws
  // lands here. Mirror the HTTP path's self-heal so a stale iframe that opens
  // a ws after the daemon restarted / ttyd was reaped picks up a freshly
  // spawned instance instead of hard-failing with terminal_not_found.
  const upgradeHandler = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const urlPath = request.url || "";
    if (!urlPath.startsWith(TERMINAL_PROXY_PREFIX)) return;
    const resolved = resolveProxyTarget(urlPath);
    if (!resolved) {
      // Hold the socket open while we try to revive ttyd. Browsers retry on
      // WS failure, but reviving avoids the surface-level error flash entirely.
      reviveProxyTarget(urlPath)
        .then((revived) => {
          if (!revived) {
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
            return;
          }
          proxy.ws(request, socket, head, { target: revived.target });
        })
        .catch(() => {
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
    ttyd.shutdown();
    proxy.close();
  });
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
  };
}
