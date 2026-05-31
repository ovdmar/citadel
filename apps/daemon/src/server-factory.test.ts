import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonServer } from "./server-factory.js";

function fakeConfig(overrides: Partial<CitadelConfig>): CitadelConfig {
  return {
    version: 1,
    dataDir: "/tmp/citadel",
    databasePath: "/tmp/citadel/citadel.sqlite",
    bindHost: "127.0.0.1",
    port: 4010,
    mcp: { enabled: true },
    providers: {
      github: { enabled: true, command: "gh" },
      jira: { enabled: true, command: "jtk" },
    },
    agentRuntimes: [],
    terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    usageProviders: [],
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] },
    commandPolicy: { hookTimeoutMs: 120000, allowDestructiveWorkspaceCleanup: false },
    scratchpad: { path: "/tmp/citadel/scratchpad.md" },
    ...overrides,
  } as unknown as CitadelConfig;
}

function generateSelfSignedCert(outDir: string, daysValid = 30) {
  const keyPath = path.join(outDir, "key.pem");
  const certPath = path.join(outDir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      String(daysValid),
      "-nodes",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  return { keyPath, certPath };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createDaemonServer", () => {
  it("returns an http.Server when config.tls is unset", () => {
    const app = express();
    const result = createDaemonServer(app, fakeConfig({}));
    expect(result.protocol).toBe("http");
    expect(result.server).toBeInstanceOf(http.Server);
    result.server.close();
  });

  it("returns an https.Server when config.tls is set and valid", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-factory-"));
    tmpDirs.push(tmp);
    const { certPath, keyPath } = generateSelfSignedCert(tmp);
    const app = express();
    const result = createDaemonServer(app, fakeConfig({ tls: { certPath, keyPath } }));
    expect(result.protocol).toBe("https");
    expect(result.server).toBeInstanceOf(https.Server);
    result.server.close();
  });

  it("throws fail-fast when config.tls points at a missing cert", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-factory-"));
    tmpDirs.push(tmp);
    expect(() =>
      createDaemonServer(
        express(),
        fakeConfig({
          tls: { certPath: path.join(tmp, "nope-cert.pem"), keyPath: path.join(tmp, "nope-key.pem") },
        }),
      ),
    ).toThrow(/TLS configuration is invalid/);
  });

  it("throws when the cert file exists but is empty", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "server-factory-"));
    tmpDirs.push(tmp);
    const certPath = path.join(tmp, "empty-cert.pem");
    const keyPath = path.join(tmp, "key.pem");
    fs.writeFileSync(certPath, "");
    fs.writeFileSync(keyPath, "any-key");
    expect(() => createDaemonServer(express(), fakeConfig({ tls: { certPath, keyPath } }))).toThrow(
      /TLS configuration is invalid/,
    );
  });
});
