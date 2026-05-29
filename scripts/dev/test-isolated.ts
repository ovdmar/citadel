import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cleanup = process.env.CITADEL_TEST_KEEP !== "1";
const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-test-"));
const dataDir = path.join(baseTmp, "data");
const configPath = path.join(dataDir, "citadel.config.json");
fs.mkdirSync(dataDir, { recursive: true });

const mode = process.argv[2] ?? "vitest";
const passthrough = process.argv.slice(3);

const env = {
  ...process.env,
  CITADEL_DATA_DIR: dataDir,
  CITADEL_CONFIG: configPath,
  CITADEL_TEST_ISOLATED: "1",
};

const commandByMode: Record<string, { cmd: string; args: string[] }> = {
  vitest: { cmd: "pnpm", args: ["run", "test", ...passthrough] },
  e2e: { cmd: "pnpm", args: ["run", "e2e", ...passthrough] },
  smoke: { cmd: "pnpm", args: ["run", "smoke", ...passthrough] },
};

const chosen = commandByMode[mode];
if (!chosen) {
  console.error(`Unknown mode: ${mode}. Expected one of: ${Object.keys(commandByMode).join(", ")}`);
  process.exit(2);
}

if (mode === "e2e") {
  // Force a fresh daemon/web port pair outside the long-term daemon
  // (4010), worktree daemon (4110-4209), and worktree Vite (5210-5309)
  // ranges. Also isolate tmux so E2E never touches live agent panes.
  env.CITADEL_PLAYWRIGHT_DATA_DIR = env.CITADEL_PLAYWRIGHT_DATA_DIR ?? dataDir;
  env.CITADEL_PLAYWRIGHT_SANDBOX_PREFIX = env.CITADEL_PLAYWRIGHT_SANDBOX_PREFIX ?? dataDir;
  env.CITADEL_PLAYWRIGHT_DAEMON_PORT = env.CITADEL_PLAYWRIGHT_DAEMON_PORT ?? randomPort(14020, 14199);
  env.CITADEL_PLAYWRIGHT_WEB_PORT = env.CITADEL_PLAYWRIGHT_WEB_PORT ?? randomPort(15180, 15399);
  env.CITADEL_PLAYWRIGHT_TMUX_SOCKET =
    env.CITADEL_PLAYWRIGHT_TMUX_SOCKET ?? `citadel-playwright-${env.CITADEL_PLAYWRIGHT_DAEMON_PORT}`;
}

console.log(`[test-isolated] mode=${mode} CITADEL_DATA_DIR=${dataDir}`);
const result = spawnSync(chosen.cmd, chosen.args, { stdio: "inherit", env });

if (cleanup) {
  try {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[test-isolated] cleanup failed for ${baseTmp}:`, error);
  }
} else {
  console.log(`[test-isolated] keeping ${baseTmp} (CITADEL_TEST_KEEP=1)`);
}

process.exit(result.status ?? 1);

function randomPort(min: number, max: number) {
  return String(Math.floor(min + Math.random() * (max - min)));
}
