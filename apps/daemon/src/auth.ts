import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type express from "express";

export const AUTH_COOKIE_NAME = "citadel_session";
export const AUTH_TOKEN_FILENAME = "auth-token";

const SESSION_MESSAGE = "citadel-session-v1";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type DaemonAuthOptions = {
  dataDir: string;
  enabled?: boolean;
  token?: string;
};

export type DaemonAuth = {
  enabled: boolean;
  tokenPath: string | null;
  isAuthenticated: (request: express.Request | http.IncomingMessage) => boolean;
  middleware: express.RequestHandler;
  authorizeUpgrade: (request: http.IncomingMessage) => boolean;
  registerRoutes: (app: express.Express) => void;
};

export function createDaemonAuth(options: DaemonAuthOptions): DaemonAuth {
  const enabled = options.enabled ?? process.env.CITADEL_AUTH_DISABLED !== "1";
  if (!enabled) {
    return {
      enabled: false,
      tokenPath: null,
      isAuthenticated: () => true,
      middleware: (_req, _res, next) => next(),
      authorizeUpgrade: () => true,
      registerRoutes: (app) => {
        app.get("/api/auth/status", (_req, res) => {
          res.json({ enabled: false, authenticated: true });
        });
      },
    };
  }

  const loaded = loadAuthToken(options);
  const sessionCookie = signSessionCookie(loaded.token);

  const isAuthenticated = (request: express.Request | http.IncomingMessage) =>
    requestHasToken(request, loaded.token) || requestHasSessionCookie(request, sessionCookie);

  const auth: DaemonAuth = {
    enabled: true,
    tokenPath: loaded.tokenPath,
    isAuthenticated,
    authorizeUpgrade: isAuthenticated,
    middleware: (req, res, next) => {
      if (isPublicRequest(req)) return next();
      if (isAuthenticated(req)) return next();
      res.status(401).json({ error: "auth_required" });
    },
    registerRoutes: (app) => {
      app.get("/api/auth/status", (req, res) => {
        res.json({
          enabled: true,
          authenticated: isAuthenticated(req),
          tokenPath: loaded.tokenPath,
        });
      });

      app.post("/api/auth/login", (req, res) => {
        const token = typeof req.body?.token === "string" ? req.body.token : "";
        if (!secureEqual(token, loaded.token)) return res.status(401).json({ error: "invalid_token" });
        res.cookie(AUTH_COOKIE_NAME, sessionCookie, {
          httpOnly: true,
          sameSite: "strict",
          secure: isSecureRequest(req),
          path: "/",
          maxAge: SESSION_MAX_AGE_MS,
        });
        res.json({ authenticated: true });
      });

      app.post("/api/auth/logout", (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME, {
          httpOnly: true,
          sameSite: "strict",
          secure: isSecureRequest(req),
          path: "/",
        });
        res.status(204).end();
      });
    },
  };

  return auth;
}

export function unauthorizedUpgrade(socket: NodeJS.WritableStream) {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
}

function loadAuthToken(options: DaemonAuthOptions): { token: string; tokenPath: string | null } {
  if (options.token) return { token: options.token, tokenPath: null };
  if (process.env.CITADEL_AUTH_TOKEN) return { token: process.env.CITADEL_AUTH_TOKEN, tokenPath: null };

  const tokenPath = path.join(options.dataDir, AUTH_TOKEN_FILENAME);
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) {
      try {
        fs.chmodSync(tokenPath, 0o600);
      } catch {
        // best-effort; the token still works if chmod is unavailable
      }
      return { token: existing, tokenPath };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const token = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(tokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
  return { token, tokenPath };
}

function signSessionCookie(token: string) {
  return crypto.createHmac("sha256", token).update(SESSION_MESSAGE).digest("base64url");
}

function requestHasToken(request: express.Request | http.IncomingMessage, token: string) {
  const authorization = headerValue(request.headers, "authorization");
  if (authorization?.startsWith("Bearer ") && secureEqual(authorization.slice("Bearer ".length), token)) return true;
  const explicit = headerValue(request.headers, "x-citadel-auth-token");
  return explicit ? secureEqual(explicit, token) : false;
}

function requestHasSessionCookie(request: express.Request | http.IncomingMessage, sessionCookie: string) {
  const cookie = parseCookies(headerValue(request.headers, "cookie") ?? "")[AUTH_COOKIE_NAME] ?? "";
  return secureEqual(cookie, sessionCookie);
}

function isPublicRequest(req: express.Request) {
  if (req.method === "OPTIONS") return true;
  if (req.path === "/api/auth/status" || req.path === "/api/auth/login" || req.path === "/api/auth/logout") {
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (req.path === "/events") return false;
  if (req.path.startsWith("/api/")) return false;
  if (req.path.startsWith("/terminals/")) return false;
  if (req.path.startsWith("/terminal/")) return false;
  return true;
}

function isSecureRequest(req: express.Request) {
  return req.secure || headerValue(req.headers, "x-forwarded-proto") === "https";
}

function headerValue(headers: http.IncomingHttpHeaders, name: string): string | null {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" ? value : null;
}

function parseCookies(header: string) {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies[rawName] = decodeURIComponent(rawValue.join("="));
    } catch {
      cookies[rawName] = rawValue.join("=");
    }
  }
  return cookies;
}

function secureEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
