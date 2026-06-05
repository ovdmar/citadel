#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const DEFAULT_PREPARE_TIMEOUT_MS = 7000;

async function main() {
  if (process.env.CITADEL_SKIP_PTY_DAEMON_HANDOFF === "1") {
    console.log("  -> PTY daemon handoff skipped by CITADEL_SKIP_PTY_DAEMON_HANDOFF=1");
    return;
  }

  const root = path.resolve(process.env.CITADEL_INSTALL_ROOT || process.cwd());
  const socketPath = resolveSocketPath();
  if (!fs.existsSync(socketPath)) {
    console.log(`  -> no PTY daemon socket at ${socketPath}; skipping handoff`);
    return;
  }

  const terminalEntry = path.join(root, "packages", "terminal", "dist", "index.js");
  if (!fs.existsSync(terminalEntry)) {
    console.log(`  -> @citadel/terminal dist missing at ${terminalEntry}; skipping PTY daemon handoff`);
    return;
  }

  const connectTimeoutMs = positiveInt(
    process.env.CITADEL_PTY_DAEMON_HANDOFF_CONNECT_TIMEOUT_MS,
    DEFAULT_CONNECT_TIMEOUT_MS,
  );
  const prepareTimeoutMs = positiveInt(
    process.env.CITADEL_PTY_DAEMON_HANDOFF_PREPARE_TIMEOUT_MS,
    DEFAULT_PREPARE_TIMEOUT_MS,
  );

  let client;
  try {
    const { connectPtyDaemonClient } = await import(pathToFileURL(terminalEntry).href);
    client = await connectPtyDaemonClient({ socketPath, timeoutMs: connectTimeoutMs });
    const previousOwnerClosed = waitForDisconnect(client);
    const result = await withTimeout(client.prepareUpgrade(), prepareTimeoutMs, "PTY daemon handoff timed out");
    if (result.ok) {
      await withTimeout(previousOwnerClosed, 1000, "previous PTY daemon owner did not close promptly").catch(() => {});
      client.dispose();
      client = undefined;
      const ready = await waitForReady(connectPtyDaemonClient, socketPath, connectTimeoutMs, 3000);
      const detail = ready ? "socket ready" : "socket readiness not confirmed";
      console.log(`  -> PTY daemon handoff prepared; successor pid ${result.successorPid}; ${detail}`);
    } else {
      console.log(`  -> PTY daemon handoff skipped: ${result.reason}`);
    }
  } catch (error) {
    console.log(`  -> PTY daemon handoff skipped: ${stringifyError(error)}`);
  } finally {
    client?.dispose();
  }
}

function resolveSocketPath() {
  if (process.env.CITADEL_PTY_DAEMON_SOCKET) return process.env.CITADEL_PTY_DAEMON_SOCKET;
  return path.join(resolveDataDir(), "run", "pty-daemon.sock");
}

function resolveDataDir() {
  const envDataDir = process.env.CITADEL_DATA_DIR || path.join(os.homedir(), ".local", "share", "citadel");
  const configPath = process.env.CITADEL_CONFIG || path.join(envDataDir, "citadel.config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (typeof raw?.dataDir === "string" && raw.dataDir.length > 0) return raw.dataDir;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  return envDataDir;
}

function positiveInt(raw, fallback) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function waitForDisconnect(client) {
  return new Promise((resolve) => {
    let off = () => {};
    off = client.onDisconnect(() => {
      off();
      resolve();
    });
  });
}

async function waitForReady(connectPtyDaemonClient, socketPath, connectTimeoutMs, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let probe;
    try {
      probe = await connectPtyDaemonClient({ socketPath, timeoutMs: connectTimeoutMs });
      await probe.list();
      return true;
    } catch {
      await sleep(50);
    } finally {
      probe?.dispose();
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function stringifyError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

await main().catch((error) => {
  console.log(`  -> PTY daemon handoff skipped: ${stringifyError(error)}`);
});
