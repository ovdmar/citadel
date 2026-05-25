import { expect, test } from "@playwright/test";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

// The /quick-capture page is daemon-served (outside /api/*), so the test hits
// the daemon directly rather than going through the cockpit web app.
test.describe("quick-capture page", () => {
  test.beforeEach(async ({ request }) => {
    // Reset the scratchpad so the captured block is the only one we see.
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: "" } });
  });

  test("submits a block via Cmd-Enter and the new block surfaces in the scratchpad", async ({ page, request }) => {
    await page.goto(`${API_BASE}/quick-capture`);
    const textarea = page.locator("textarea#t");
    await expect(textarea).toBeFocused();
    await textarea.fill("captured from /quick-capture");
    await textarea.press("ControlOrMeta+Enter");

    // The page either closes (Chromium opens us as a regular tab so close is
    // a no-op) or swaps for the confirmation message. Either way, the block
    // is created — assert via the API rather than relying on the page's
    // post-submit state.
    await expect
      .poll(async () => {
        const res = await request.get(`${API_BASE}/api/scratchpad/blocks`);
        const body = (await res.json()) as { blocks: Array<{ text: string }> };
        return body.blocks.map((b) => b.text).join("|");
      })
      .toContain("captured from /quick-capture");
  });

  test("response is HTML and references the existing block endpoint", async ({ request }) => {
    const response = await request.get(`${API_BASE}/quick-capture`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toMatch(/text\/html/);
    const body = await response.text();
    expect(body).toContain("/api/scratchpad/blocks");
  });
});
