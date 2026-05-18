import { defineConfig, devices } from "@playwright/test";

const daemonPort = process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012";
const webPort = process.env.CITADEL_PLAYWRIGHT_WEB_PORT || "5174";
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
      command: `CITADEL_DATA_DIR=/tmp/citadel-playwright-data CITADEL_PORT=${daemonPort} pnpm --filter @citadel/daemon dev`,
      url: `${daemonBase}/api/health`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: `CITADEL_DAEMON_URL=${daemonBase} CITADEL_WEB_PORT=${webPort} pnpm --filter @citadel/web dev`,
      url: webBase,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
