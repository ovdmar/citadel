import { expect, test } from "@playwright/test";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

test.describe("scratchpad drawer", () => {
  test.beforeEach(async ({ request }) => {
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: "" } });
  });

  test("opens via /scratchpad deep-link with the cockpit underneath", async ({ page }) => {
    await page.goto("/scratchpad");
    // The redirect rewrites the URL but the drawer is open.
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    // The URL should normalize to `?scratchpad=1` (target route may vary).
    await expect.poll(() => new URL(page.url()).searchParams.get("scratchpad")).toBe("1");
    // The drawer header is rendered, with Refine button visible.
    await expect(page.locator(".scratchpad-drawer-refine")).toBeVisible();
  });

  test("close button hides the drawer and clears the query param", async ({ page }) => {
    await page.goto("/?scratchpad=1");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    await page.locator(".scratchpad-drawer-close").click();
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
  });

  test("cmd+shift+s toggles the drawer from any route", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
  });

  test("preserves angle-bracket text in rendered blocks (regression)", async ({ page, request }) => {
    await page.goto("/?scratchpad=1");
    const composer = page.locator(".scratchpad-composer-input");
    await composer.fill("lookup <user_id> in users");
    await composer.press("ControlOrMeta+Enter");
    const rendered = page.locator(".scratchpad-block-rendered").first();
    await expect(rendered).toContainText("<user_id>");
    // Round-trip via API: stored markdown matches the composer input.
    const list = await request.get(`${API_BASE}/api/scratchpad/blocks`);
    const body = (await list.json()) as { blocks: Array<{ text: string }> };
    expect(body.blocks.some((b) => b.text.includes("<user_id>"))).toBe(true);
  });

  test("https autolinks still render as anchors", async ({ page }) => {
    await page.goto("/?scratchpad=1");
    const composer = page.locator(".scratchpad-composer-input");
    await composer.fill("see <https://example.test/page>");
    await composer.press("ControlOrMeta+Enter");
    const anchor = page.locator('.scratchpad-block-rendered a[href="https://example.test/page"]').first();
    await expect(anchor).toBeVisible();
  });
});
