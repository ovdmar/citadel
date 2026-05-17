import { expect, test } from "@playwright/test";

test("operator cockpit renders key local-first views", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Provider Health" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtime Launch" })).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-cockpit.png`, fullPage: true });
});

test("settings renders runtime and MCP visibility", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Runtimes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP" })).toBeVisible();
  await page.screenshot({ path: `docs/campaigns/screenshot-${testInfo.project.name}-settings.png`, fullPage: true });
});
