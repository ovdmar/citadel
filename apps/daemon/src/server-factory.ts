import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { CitadelConfig } from "@citadel/config";
import { validateTlsAssets } from "@citadel/config";
import type express from "express";

// Build the HTTP or HTTPS server that the daemon listens on. Switches on
// the presence of config.tls — when set, returns an https.Server with the
// cert/key loaded from disk. WebSockets attach identically to either kind
// of server, so the terminal WebSocket gateway works unchanged.
//
// validateTlsAssets() runs first: refuses to boot on missing/empty/expired
// cert. The zod schema only checks path shape (pure refines); this is the
// runtime side of the contract.

export type CreateDaemonServerResult = {
  server: http.Server | https.Server;
  protocol: "http" | "https";
};

export function createDaemonServer(app: express.Express, config: CitadelConfig): CreateDaemonServerResult {
  if (!config.tls) {
    return { server: http.createServer(app), protocol: "http" };
  }
  const tlsResult = validateTlsAssets(config);
  if (tlsResult && tlsResult.ok === false) {
    // Fail-fast at boot — never silently fall back to HTTP when TLS was
    // requested. An operator who set config.tls expects TLS or a clear error.
    throw new Error(`TLS configuration is invalid: ${tlsResult.reason}`);
  }
  const cert = fs.readFileSync(config.tls.certPath);
  const key = fs.readFileSync(config.tls.keyPath);
  return { server: https.createServer({ cert, key }, app), protocol: "https" };
}
