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
      command: `CITADEL_DATA_DIR=/tmp/citadel-playwright-data CITADEL_PORT=${daemonPort} pnpm --filter @citadel/daemon dev`,
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
