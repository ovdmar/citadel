import type http from "node:http";
import type { Duplex } from "node:stream";
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

  app.post("/api/agent-sessions/:sessionId/terminal", async (req, res) => {
    const sessionId = String(req.params.sessionId ?? "");
    const session = resolveSession(sessionId);
    if (!session) return res.status(404).json({ error: "session_not_found" });
    try {
      const entry = await ttyd.ensure({
        key: session.sessionId,
        tmuxSession: session.tmuxSession,
        worktreePath: session.worktreePath,
      });
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
  app.use((req, res, next) => {
    if (!req.url.startsWith(TERMINAL_PROXY_PREFIX)) return next();
    const resolved = resolveProxyTarget(req.url);
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

  // WebSocket upgrade: ttyd opens /ws under the base path, so /terminals/:key/ws lands here.
  const upgradeHandler = (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const urlPath = request.url || "";
    if (!urlPath.startsWith(TERMINAL_PROXY_PREFIX)) return;
    const resolved = resolveProxyTarget(urlPath);
    if (!resolved) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
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
