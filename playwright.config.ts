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
const daemonLog = process.env.CITADEL_PLAYWRIGHT_DAEMON_LOG || "/tmp/citadel-playwright-daemon.log";
const dataDir =
  process.env.CITADEL_DATA_DIR || process.env.CITADEL_PLAYWRIGHT_DATA_DIR || "/tmp/citadel-playwright-data";
const daemonBase = `http://127.0.0.1:${daemonPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const tmuxSocket = (process.env.CITADEL_PLAYWRIGHT_TMUX_SOCKET || `citadel-playwright-${daemonPort}`).replace(
  /[^A-Za-z0-9_.-]/g,
  "-",
);

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Each Playwright invocation talks to one sandbox daemon and one shared data
  // dir. The package e2e script runs viewport projects as separate invocations
  // so the owned daemon is restarted between viewport suites.
  workers: 1,
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
      //
      // The e2e daemon must also own an isolated tmux socket. A sandbox DB
      // restored from prod can contain real session
      // names; if the test process inherits CITADEL_TMUX_SOCKET=citadel, the
      // boot orphan-reaper can mistake production tmux panes for sandbox
      // orphans and kill the user's live terminals.
      command: [
        `CITADEL_DATA_DIR=${dataDir}`,
        `CITADEL_PORT=${daemonPort}`,
        `CITADEL_TMUX_SOCKET=${tmuxSocket}`,
        "CITADEL_OWN_TMUX_SOCKET=1",
        "CITADEL_DISABLE_BOOT_RESTORE=1",
        "CITADEL_DISABLE_REAPER=1",
        "CITADEL_DISABLE_STATUS_MONITOR=1",
        "CITADEL_DISABLE_SCHEDULER=1",
        "CITADEL_AUTO_RECOVERY_DISABLED=1",
        "CITADEL_DISABLE_AUTO_RESUME=1",
        "CITADEL_DISABLE_FS_WATCHERS=1",
        "CITADEL_DISABLE_TERMINAL_REAPER=1",
        "CITADEL_GH_SCHEDULER_DISABLED=1",
        "CITADEL_MAIN_WATCHER_DISABLED=1",
        `CITADEL_PLAYWRIGHT_DAEMON_LOG=${daemonLog}`,
        // E2E writes screenshot artifacts under docs/campaigns. Run the
        // built daemon, not tsx watch/source mode, so CI cannot restart the
        // API server between tests and surface transient ECONNRESETs.
        'sh -c \'rm -f "$CITADEL_PLAYWRIGHT_DAEMON_LOG"; case "$CITADEL_DATA_DIR" in /tmp/citadel-playwright-*|/tmp/citadel-test-*) rm -rf "$CITADEL_DATA_DIR" ;; *) echo "Refusing to clean non-Playwright data dir: $CITADEL_DATA_DIR" >&2; exit 2 ;; esac; (pnpm --filter @citadel/daemon... build && pnpm --filter @citadel/daemon start) >"$CITADEL_PLAYWRIGHT_DAEMON_LOG" 2>&1; code=$?; echo "[playwright-daemon] exited $code at $(date -u +%FT%TZ)" >>"$CITADEL_PLAYWRIGHT_DAEMON_LOG"; exit $code\'',
      ].join(" "),
      url: `${daemonBase}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `CITADEL_DAEMON_URL=${daemonBase} CITADEL_WEB_PORT=${webPort} pnpm --filter @citadel/web dev`,
      url: webBase,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
