import { defineConfig, devices } from "@playwright/test";

// Use a port well outside the 4010 (systemd prod) / 4110-4209 (worktree dev)
// ranges so the e2e default cannot collide with a real Citadel install.
// History: when the default sat at 4012, `reuseExistingServer: true` made
// Playwright silently reuse a production daemon listening on that port and
// the e2e suite overwrote the user's scratchpad with fixture data
// ("first idea\n\nsecond idea\n", etc.) instead of writing to its sandbox
// data dir at /tmp/citadel-playwright-data.
const daemonPort = process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "14012";
const webPort = process.env.CITADEL_PLAYWRIGHT_WEB_PORT || "15174";
const daemonBase = `http://127.0.0.1:${daemonPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const tmuxSocket = (process.env.CITADEL_PLAYWRIGHT_TMUX_SOCKET || `citadel-playwright-${daemonPort}`).replace(
  /[^A-Za-z0-9_.-]/g,
  "-",
);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: webBase,
    trace: "retain-on-failure",
    extraHTTPHeaders: {
      "X-Citadel-Api-Base": daemonBase,
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "tablet", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      // `reuseExistingServer: false` so the suite always launches a daemon
      // it owns (with the sandbox CITADEL_DATA_DIR below). Reusing whatever
      // happens to listen on `daemonPort` was how prod data got clobbered.
      command: [
        "CITADEL_DATA_DIR=/tmp/citadel-playwright-data",
        `CITADEL_PORT=${daemonPort}`,
        `CITADEL_TMUX_SOCKET=${tmuxSocket}`,
        "CITADEL_DISABLE_BOOT_RESTORE=1",
        "CITADEL_DISABLE_REAPER=1",
        "CITADEL_DISABLE_STATUS_MONITOR=1",
        "CITADEL_DISABLE_SCHEDULER=1",
        "CITADEL_AUTO_RECOVERY_DISABLED=1",
        "CITADEL_DISABLE_AUTO_RESUME=1",
        "CITADEL_DISABLE_FS_WATCHERS=1",
        "CITADEL_DISABLE_TERMINAL_REAPER=1",
        // E2E writes screenshot artifacts under docs/campaigns. Run the
        // built daemon, not tsx watch/source mode, so CI cannot restart the
        // API server between tests and surface transient ECONNRESETs.
        "sh -c 'pnpm --filter @citadel/daemon build >/dev/null && pnpm --filter @citadel/daemon start'",
      ].join(" "),
      url: `${daemonBase}/api/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `CITADEL_DAEMON_URL=${daemonBase} CITADEL_WEB_PORT=${webPort} pnpm --filter @citadel/web dev`,
      url: webBase,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
