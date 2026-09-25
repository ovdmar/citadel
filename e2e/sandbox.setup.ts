import { test } from "@playwright/test";
import { assertDaemonIsSandbox } from "./helpers/sandbox-guard.js";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "14012"}`;

test("target daemon is the Playwright sandbox", async ({ request }) => {
  await assertDaemonIsSandbox(request, API_BASE);
});
