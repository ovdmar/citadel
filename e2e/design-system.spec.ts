import { expect, test } from "@playwright/test";

// Smokes the dev-only /design-system showcase route. Verifies the page
// loads without console errors, every primitive section is present, and
// the load-bearing interactive flows (Dialog open/close, Tabs nav, Toast
// emit + dismiss) work end-to-end through Radix and the custom toast
// queue.
//
// The route is registered behind `if (import.meta.env.DEV)` in main.tsx —
// the production build verification step (grep for the marker in dist/)
// is part of /implement-task's targeted checks, not this spec.

test.describe("design-system showcase", () => {
  test("loads with every section present and no console errors", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop covers the side-by-side theme layout");
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });

    await page.goto("/design-system");
    await expect(page.locator('[data-section="buttons"]').first()).toBeVisible();
    await expect(page.locator('[data-section="pills"]').first()).toBeVisible();
    await expect(page.locator('[data-section="surfaces"]').first()).toBeVisible();
    await expect(page.locator('[data-section="forms"]').first()).toBeVisible();
    await expect(page.locator('[data-section="overlays"]').first()).toBeVisible();
    await expect(page.locator('[data-section="navigation"]').first()).toBeVisible();
    await expect(page.locator('[data-section="feedback"]').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("opens a Dialog from the overlays section and closes it via Escape", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop covers the multi-pane showcase");
    await page.goto("/design-system");
    // Side-by-side layout renders both light and dark panes — open dialog
    // from the first pane only to keep state assertions deterministic.
    const overlays = page.locator('[data-section="overlays"]').first();
    await overlays.getByRole("button", { name: "Open dialog" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("Tabs strip switches active tab on click", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop covers the multi-pane showcase");
    await page.goto("/design-system");
    const nav = page.locator('[data-section="navigation"]').first();
    const tablist = nav.locator('[role="tablist"]').first();
    await tablist.getByRole("tab", { name: "Diff" }).click();
    await expect(tablist).toHaveAttribute("data-active", "diff");
  });

  test("Toast trigger emits a toast and it auto-dismisses", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "desktop covers the multi-pane showcase");
    await page.goto("/design-system");
    const feedback = page.locator('[data-section="feedback"]').first();
    await feedback.getByRole("button", { name: "Default" }).click();
    const toaster = page.locator('[data-component="toaster"]').first();
    await expect(toaster).toContainText("Default toast");
    // Default duration is 5s; allow a small buffer for the dismiss to settle.
    await expect(toaster).not.toContainText("Default toast", { timeout: 8_000 });
  });
});
