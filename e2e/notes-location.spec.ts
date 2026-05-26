import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "4012"}`;

// End-to-end coverage for the configurable notes location. Exercises the round
// trip Settings → daemon config → /api/scratchpad → cockpit, plus the fallback
// when the user clears the override.
test.describe("notes location", () => {
  const tmpFiles: string[] = [];

  test.afterEach(async ({ request }) => {
    // Reset to the default notes location so subsequent tests aren't pinned
    // to a tmp path that may have been deleted.
    await request.put(`${API_BASE}/api/config`, { data: { scratchpad: { path: undefined } } });
    // Also empty the default scratchpad — otherwise leftover content here can
    // trigger a `migrate-to-blocks` history entry on the next test's first
    // read, which double-counts pills in scratchpad-blocks.spec.ts. Test
    // isolation only goes as deep as the shared daemon state allows.
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: "" } });
    for (const file of tmpFiles.splice(0)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  test("Settings round-trips a custom notes path and the daemon writes to disk at it", async ({ page, request }) => {
    const tmpNotes = path.join(os.tmpdir(), `citadel-e2e-notes-${Date.now()}.md`);
    tmpFiles.push(tmpNotes);

    await page.goto("/settings");
    await page.getByRole("button", { name: "Notes" }).click();

    const input = page.locator('[data-testid="notes-location-input"]');
    await expect(input).toBeVisible();
    await input.fill(tmpNotes);

    await page.getByRole("button", { name: /^save$/i }).click();

    // Reload — the field round-trips through PUT /api/config.
    await page.reload();
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.locator('[data-testid="notes-location-input"]')).toHaveValue(tmpNotes);

    // Daemon-side: /api/scratchpad now reads/writes at the configured path.
    const snapshot = (await (await request.get(`${API_BASE}/api/scratchpad`)).json()) as {
      content: string;
      path: string;
    };
    expect(snapshot.path).toBe(tmpNotes);

    // Filesystem-level verification: writing through the cockpit's PUT must
    // land at the configured file, NOT at the old default path. This catches
    // any regression where the daemon returns the configured path in the
    // response but actually writes elsewhere. We write content already in the
    // fenced-block format so reading it later (e.g. via the cockpit
    // navigation below) does NOT trigger `migrate-to-blocks` and leak a
    // history entry into the shared <dataDir>/scratchpad-history.jsonl —
    // other e2e specs assert exact history counts.
    const marker = `notes-location-e2e-${Date.now()}`;
    const fencedMarker = `<!-- block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\n${marker}\n<!-- /block:11111111-aaaa-4bbb-8ccc-aaaaaaaaaaaa -->\n`;
    await request.put(`${API_BASE}/api/scratchpad`, { data: { content: fencedMarker } });
    expect(fs.existsSync(tmpNotes)).toBe(true);
    expect(fs.readFileSync(tmpNotes, "utf8")).toContain(marker);

    // Cockpit displays the resolved path in the scratchpad header subtitle.
    await page.goto("/scratchpad");
    await expect(page.locator('[data-testid="scratchpad-path"]')).toHaveText(tmpNotes);
  });

  test("clearing the field falls back to the default <dataDir>/scratchpad.md", async ({ page, request }) => {
    const tmpNotes = path.join(os.tmpdir(), `citadel-e2e-notes-${Date.now()}-fallback.md`);
    tmpFiles.push(tmpNotes);

    // First set a custom path so there's something to clear.
    await request.put(`${API_BASE}/api/config`, { data: { scratchpad: { path: tmpNotes } } });

    await page.goto("/settings");
    await page.getByRole("button", { name: "Notes" }).click();
    const input = page.locator('[data-testid="notes-location-input"]');
    await expect(input).toHaveValue(tmpNotes);

    // Clear and save.
    await input.fill("");
    await page.getByRole("button", { name: /^save$/i }).click();

    await page.reload();
    await page.getByRole("button", { name: "Notes" }).click();
    await expect(page.locator('[data-testid="notes-location-input"]')).toHaveValue("");

    // Daemon-side: path resolves back to a non-tmp location under dataDir.
    const snapshot = (await (await request.get(`${API_BASE}/api/scratchpad`)).json()) as {
      path: string;
    };
    expect(snapshot.path).not.toBe(tmpNotes);
    expect(snapshot.path.endsWith("scratchpad.md")).toBe(true);
  });
});
