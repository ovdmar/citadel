import { expect, test } from "@playwright/test";
import { apiGet, apiPut } from "./helpers/api-request.js";
import { assertDaemonIsSandbox } from "./helpers/sandbox-guard.js";

// Provider-cache + reload-affordance smoke tests. These exercise the
// user-visible pieces of the provider-data-caching PR end-to-end:
//
//   - GET /api/workspaces/pr-state returns a cache-only snapshot.
//   - The usage-pill reload affordance renders a clickable button rather
//     than a dead-end "—" when usage data is missing/errored.
//
// NOT covered here (deferred to a follow-up): the warm-boot 200ms perf
// assertion requires booting a daemon with a pre-seeded provider-cache.json
// outside the playwright harness's reuseExistingServer model. The unit-test
// suite covers the cache hydration + serialization path.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "14012"}`;

test.beforeAll(async ({ request }) => {
  await assertDaemonIsSandbox(request, API_BASE);
});

test("GET /api/workspaces/pr-state returns a cache-only snapshot", async ({ request }) => {
  const response = await apiGet(request, `${API_BASE}/api/workspaces/pr-state`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { workspacePrState: Record<string, unknown> };
  expect(body).toHaveProperty("workspacePrState");
  expect(typeof body.workspacePrState).toBe("object");
});

test("usage indicator renders a reload button when usage data is unavailable", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "top-bar usage pill is desktop/tablet only");
  // Enable showUsageInTopBar so the indicator is visible. The CI test daemon
  // has no real runtime binaries on PATH, so usage will be unavailable —
  // exactly the path that produces the reload button.
  const configResp = await apiGet(request, `${API_BASE}/api/config`);
  const configBody = (await configResp.json()) as { config: { agentRuntimes: Array<{ id: string }> } };
  const runtimeId = configBody.config.agentRuntimes[0]?.id;
  test.skip(!runtimeId, "no agent runtime configured in the test daemon");
  await apiPut(request, `${API_BASE}/api/config`, {
    data: {
      agentRuntimes: configBody.config.agentRuntimes.map((r) =>
        r.id === runtimeId ? { ...r, showUsageInTopBar: true } : r,
      ),
    },
  });
  await page.goto("/");
  // The reload button uses the same .cit-usage-pill chrome but is a <button>.
  const reloadButton = page.locator("button.cit-usage-pill.cit-usage-pill--reload").first();
  await expect(reloadButton).toBeVisible({ timeout: 5_000 });
});

test("clicking the usage reload button triggers a refresh request", async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name === "mobile", "top-bar usage pill is desktop/tablet only");
  const configResp = await apiGet(request, `${API_BASE}/api/config`);
  const configBody = (await configResp.json()) as { config: { agentRuntimes: Array<{ id: string }> } };
  const runtimeId = configBody.config.agentRuntimes[0]?.id;
  test.skip(!runtimeId, "no agent runtime configured in the test daemon");
  await apiPut(request, `${API_BASE}/api/config`, {
    data: {
      agentRuntimes: configBody.config.agentRuntimes.map((r) =>
        r.id === runtimeId ? { ...r, showUsageInTopBar: true } : r,
      ),
    },
  });

  await page.goto("/");
  const reloadButton = page.locator("button.cit-usage-pill.cit-usage-pill--reload").first();
  await expect(reloadButton).toBeVisible();

  const refreshRequestPromise = page.waitForRequest(
    (req) => req.url().endsWith(`/api/runtimes/${runtimeId}/usage/refresh`) && req.method() === "POST",
  );
  await reloadButton.click();
  const refreshRequest = await refreshRequestPromise;
  expect(refreshRequest.method()).toBe("POST");
});
