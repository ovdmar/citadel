import { expect, test } from "@playwright/test";

// Route-level smoke for the merge-conflicts loop. The full UI affordance
// (`tone-conflicting` workspace card + Fix-conflicts button) requires a PR
// in the CONFLICTING mergeable state, which we cannot fabricate against a
// live `gh` provider from the E2E harness. The Vitest layer covers prToneFor
// precedence, readiness state transitions, and the daemon route behavior.
// This spec verifies the new HTTP surface ships in the deployed daemon.

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test("POST /api/workspaces/:id/fix-conflicts is registered (404 for unknown workspace)", async ({ request }) => {
  const response = await request.post(`${API_BASE}/api/workspaces/ws_does_not_exist/fix-conflicts`, {
    data: {},
  });
  expect(response.status()).toBe(404);
  const body = (await response.json()) as { error: string };
  expect(body.error).toBe("workspace_not_found");
});
