import { expect, test } from "@playwright/test";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

// Seed the scratchpad with legacy (blank-line-separated) content directly via the
// daemon HTTP, then verify the cockpit migrates it on first read and surfaces
// the `migrate-to-blocks` history entry.
test.describe("scratchpad blocks", () => {
  test.beforeEach(async ({ request }) => {
    // Reset to a known stub before each test so prior fixtures don't carry over.
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: "" } });
  });

  test("migrates legacy content on first read and shows migrate-to-blocks in history", async ({ page, request }, testInfo) => {
    // Seed legacy content via byte-faithful PUT.
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: "first idea\n\nsecond idea\n" } });

    await page.goto("/scratchpad");

    // GET blocks (server-side migration runs) — UI fetches /api/scratchpad/blocks.
    const blockList = page.locator(".scratchpad-block-list");
    await expect(blockList).toBeVisible();
    await expect(blockList.getByText("first idea")).toBeVisible();
    await expect(blockList.getByText("second idea")).toBeVisible();

    // The history sidebar is hidden on the narrow (mobile/tablet) layouts;
    // assert the migrate-to-blocks pill via the API on those projects.
    if (testInfo.project.name === "desktop") {
      const history = page.locator(".scratchpad-history-list");
      await expect(history.locator(".source-migrate")).toBeVisible();
    } else {
      const list = await request.get(`${API_BASE}/api/scratchpad/history`);
      const body = (await list.json()) as { entries: Array<{ source: string }> };
      expect(body.entries.map((e) => e.source)).toContain("migrate-to-blocks");
    }
  });

  test("composer creates a new block via Cmd-Enter", async ({ page, request }) => {
    await page.goto("/scratchpad");
    const composer = page.locator(".scratchpad-composer-input");
    await composer.focus();
    await composer.fill("composer note");
    // Use Control+Enter on Linux test runners; Cmd+Enter on macOS — Playwright maps both.
    await composer.press("ControlOrMeta+Enter");
    await expect(page.locator(".scratchpad-block-list").getByText("composer note")).toBeVisible();
    // Composer is cleared.
    await expect(composer).toHaveValue("");

    // Confirm via the API that exactly one block exists.
    const list = await request.get(`${API_BASE}/api/scratchpad/blocks`);
    const body = (await list.json()) as { blocks: Array<{ text: string }> };
    expect(body.blocks.map((b) => b.text)).toEqual(["composer note"]);
  });

  test("clicking a block enters edit mode and Cmd-Enter saves", async ({ page, request }) => {
    // Seed one block via the API so we have a target.
    await request.post(`${API_BASE}/api/scratchpad/blocks`, { data: { text: "original" } });
    await page.goto("/scratchpad");

    const block = page.locator(".scratchpad-block").first();
    await block.click();

    const textarea = block.locator("textarea");
    await expect(textarea).toBeFocused();
    await textarea.fill("rewritten");
    await textarea.press("ControlOrMeta+Enter");

    // Edit mode exits; rendered text reflects the new value.
    await expect(textarea).toHaveCount(0);
    await expect(page.locator(".scratchpad-block-rendered").first()).toContainText("rewritten");
  });

  test("composer blur with non-empty content creates a block", async ({ page, request }) => {
    await page.goto("/scratchpad");
    const composer = page.locator(".scratchpad-composer-input");
    await composer.focus();
    await composer.fill("blur should save this");
    // Defocus by clicking elsewhere — onBlur should fire and submit.
    await page.locator(".dashboard-title").click();
    await expect(page.locator(".scratchpad-block-list").getByText("blur should save this")).toBeVisible();
    const list = await request.get(`${API_BASE}/api/scratchpad/blocks`);
    const body = (await list.json()) as { blocks: Array<{ text: string }> };
    expect(body.blocks.map((b) => b.text)).toContain("blur should save this");
  });

  test("editing a block to empty deletes it", async ({ page, request }) => {
    await request.post(`${API_BASE}/api/scratchpad/blocks`, { data: { text: "delete me via empty edit" } });
    await page.goto("/scratchpad");
    const block = page.locator(".scratchpad-block").first();
    await block.click();
    const textarea = block.locator("textarea");
    await textarea.fill("");
    await textarea.press("ControlOrMeta+Enter");
    await expect(page.getByText("delete me via empty edit")).toHaveCount(0);
    const list = await request.get(`${API_BASE}/api/scratchpad/blocks`);
    const body = (await list.json()) as { blocks: unknown[] };
    expect(body.blocks).toHaveLength(0);
  });

  test("hover-delete removes a block; undo restores it", async ({ page, request }) => {
    await request.post(`${API_BASE}/api/scratchpad/blocks`, { data: { text: "block to delete" } });
    await page.goto("/scratchpad");
    const block = page.locator(".scratchpad-block").first();
    await block.hover();
    await block.getByRole("button", { name: "Delete block" }).click();

    // Block disappears, undo toast appears.
    await expect(page.getByText("block to delete")).toHaveCount(0);
    const toast = page.locator(".scratchpad-undo-toast");
    await expect(toast).toBeVisible();

    await toast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".scratchpad-block-list").getByText("block to delete")).toBeVisible();
  });
});
