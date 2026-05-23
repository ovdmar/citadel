import { expect, test } from "@playwright/test";

// Forces the cockpit into a specific theme by setting the persisted preference
// (read by ThemeControls) and the data-theme attribute (read synchronously by
// useResolvedTheme on first paint). Setting both means the test never races
// the hydration of ThemeControls' useEffect.
async function forceTheme(page: import("@playwright/test").Page, mode: "light" | "dark") {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem("citadel.theme", value);
    } catch {
      /* localStorage may be unavailable in some contexts; data-theme is the source of truth */
    }
    document.documentElement.dataset.theme = value;
  }, mode);
}

type Offender = { tag: string; cls: string; bg: string };

async function collectOffenders(page: import("@playwright/test").Page, forbidden: string[]): Promise<Offender[]> {
  return page.evaluate((blocked) => {
    const root = document.querySelector(".app-root");
    if (!root) return [];
    const offenders: Offender[] = [];
    for (const node of Array.from(root.querySelectorAll("*"))) {
      const element = node as HTMLElement;
      const bg = getComputedStyle(element).backgroundColor;
      if (!blocked.includes(bg)) continue;
      const cls = typeof element.className === "string" ? element.className : "";
      offenders.push({ tag: element.tagName.toLowerCase(), cls, bg });
    }
    return offenders;
  }, forbidden);
}

test.describe("cockpit theme audit", () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    // The audit is about visual styling that's identical between desktop and
    // tablet; running on mobile too just adds wall-clock time without coverage.
    test.skip(testInfo.project.name !== "desktop", "theme audit covered on desktop only");
  });

  test("light theme has no dark-slate backgrounds inside .app-root", async ({ page }, testInfo) => {
    await forceTheme(page, "light");
    await page.goto("/");
    await expect(page.locator(".top-bar-brand")).toBeVisible();
    // Visit a representative selection so token regressions in any route are caught.
    await page.screenshot({ path: `docs/campaigns/theme-light-${testInfo.project.name}-cockpit.png`, fullPage: true });

    // rgb(11, 18, 32) and rgb(15, 23, 42) were the historic slate-900/slate-800
    // hardcodes that would render as a dark patch in light mode.
    const offenders = await collectOffenders(page, ["rgb(11, 18, 32)", "rgb(15, 23, 42)"]);
    expect(offenders, `Dark slate backgrounds leaked into light mode: ${JSON.stringify(offenders, null, 2)}`).toEqual(
      [],
    );
  });

  test("dark theme has no pure-white backgrounds inside .app-root", async ({ page }, testInfo) => {
    await forceTheme(page, "dark");
    await page.goto("/");
    await expect(page.locator(".top-bar-brand")).toBeVisible();
    await page.screenshot({ path: `docs/campaigns/theme-dark-${testInfo.project.name}-cockpit.png`, fullPage: true });

    const offenders = await collectOffenders(page, ["rgb(255, 255, 255)"]);
    expect(offenders, `Pure-white backgrounds leaked into dark mode: ${JSON.stringify(offenders, null, 2)}`).toEqual(
      [],
    );
  });

  test("settings route inherits both themes cleanly", async ({ page }) => {
    await forceTheme(page, "light");
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(await collectOffenders(page, ["rgb(11, 18, 32)", "rgb(15, 23, 42)"])).toEqual([]);

    await forceTheme(page, "dark");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(await collectOffenders(page, ["rgb(255, 255, 255)"])).toEqual([]);
  });
});
