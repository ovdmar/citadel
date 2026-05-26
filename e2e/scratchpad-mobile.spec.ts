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
    // Plan AC2b: composer should be focused after the redirect lands.
    await expect(composer).toBeFocused();

    // Plan AC2b: tap targets (mic, delete, save) ≥ 36×36 logical px. If
    // SpeechRecognition isn't exposed in headless Chromium the mic returns
    // null and the locator count is 0 — accept that and assert the size only
    // when the element is present.
    const mic = page.locator(".scratchpad-mic").first();
    if ((await mic.count()) > 0) {
      const box = await mic.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(36);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    }
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
