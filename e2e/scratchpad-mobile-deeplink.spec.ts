import { expect, test } from "@playwright/test";

// Regression guard for the BLOCKER-2 fix: the mobile redirect must NOT eat
// /?modal=new-workspace. On a narrow viewport the cockpit should still
// render at / and auto-open the Create Workspace modal via the deeplink.
test.describe("scratchpad — mobile deeplink", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 820, "mobile-only behavior");

  test("?modal=new-workspace lands on cockpit (no redirect) and opens the modal", async ({ page }) => {
    await page.goto("/?modal=new-workspace");
    // URL must NOT be /scratchpad even though we're on a narrow viewport.
    await expect(page).not.toHaveURL(/\/scratchpad$/);
    // The existing Create Workspace modal opens via the deeplink. The modal
    // header is "Create Workspace" — match loosely so future copy tweaks
    // don't break the regression guard.
    const heading = page.getByRole("heading", { name: /create workspace|new workspace/i });
    await expect(heading).toBeVisible();
  });
});
