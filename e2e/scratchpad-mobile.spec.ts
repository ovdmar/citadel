import { expect, test } from "@playwright/test";

// Mobile-first scratchpad behavior. Skipped on the desktop/tablet projects so
// we don't false-positive — the redirect is gated on (max-width: 820px).
test.describe("scratchpad — mobile first", () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) > 820, "mobile-only behavior");

  test("bare root on a narrow viewport redirects to /scratchpad", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/scratchpad$/);
    const composer = page.locator(".scratchpad-composer-input");
    await expect(composer).toBeVisible();
  });

  test("history sidebar is hidden by default; History toggle is present in the header", async ({ page }) => {
    await page.goto("/scratchpad");
    const toggle = page.getByRole("button", { name: /history/i });
    await expect(toggle).toBeVisible();
    // Default: not open → list is not visible.
    await expect(page.locator(".scratchpad-history-list")).toBeHidden();
    await toggle.click();
    await expect(page.locator(".scratchpad-history-list")).toBeVisible();
  });
});
