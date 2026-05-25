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
    for (const node of root.querySelectorAll("*")) {
      const element = node as HTMLElement;
      const bg = getComputedStyle(element).backgroundColor;
      if (!blocked.includes(bg)) continue;
      const cls = typeof element.className === "string" ? element.className : "";
      offenders.push({ tag: element.tagName.toLowerCase(), cls, bg });
    }
    return offenders;
  }, forbidden);
}

// Opens the command palette so its backdrop, panel, and box-shadow are part of
// the audited DOM. The palette renders inline (not via portal) so it sits
// under .app-root and shows up in collectOffenders.
async function openCommandPalette(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Search workspaces" }).click();
  await expect(page.locator(".command-palette")).toBeVisible();
}

const DARK_SLATE_OFFENDERS = ["rgb(11, 18, 32)", "rgb(15, 23, 42)"];
const PURE_WHITE_OFFENDER = ["rgb(255, 255, 255)"];
// Light theme is a warm beige palette; any panel that renders as pure white or
// the historic cool near-white (#fffefa) clashes with --surface (#f4f2ee) and
// breaks the unitary look that this audit guards.
const COOL_WHITE_OFFENDERS_LIGHT = ["rgb(255, 255, 255)", "rgb(255, 254, 250)"];

test.describe("cockpit theme audit", () => {
  test.beforeEach(async ({ page: _page }, testInfo) => {
    // Mobile collapses the layout and hides the command palette trigger; the
    // visual contract there is covered by the existing mobile spec. Desktop
    // and tablet share the same chrome, so we run on both to catch viewport-
    // gated regressions.
    test.skip(testInfo.project.name === "mobile", "theme audit covers desktop and tablet viewports");
  });

  test("light theme has no dark-slate backgrounds inside .app-root", async ({ page }, testInfo) => {
    await forceTheme(page, "light");
    await page.goto("/");
    await expect(page.locator(".cit-brand")).toBeVisible();
    await openCommandPalette(page);
    await page.screenshot({ path: `docs/campaigns/theme-light-${testInfo.project.name}-cockpit.png`, fullPage: true });

    // rgb(11, 18, 32) and rgb(15, 23, 42) were the historic slate-900/slate-800
    // hardcodes that would render as a dark patch in light mode.
    const darkOffenders = await collectOffenders(page, DARK_SLATE_OFFENDERS);
    expect(
      darkOffenders,
      `Dark slate backgrounds leaked into light mode: ${JSON.stringify(darkOffenders, null, 2)}`,
    ).toEqual([]);

    // The warm beige palette must not contain pure-white or cool near-white
    // panels — those clash with --surface and motivated this audit in the
    // first place.
    const coolOffenders = await collectOffenders(page, COOL_WHITE_OFFENDERS_LIGHT);
    expect(
      coolOffenders,
      `Cool/white panels leaked into the warm light palette: ${JSON.stringify(coolOffenders, null, 2)}`,
    ).toEqual([]);
  });

  test("dark theme has no pure-white backgrounds inside .app-root", async ({ page }, testInfo) => {
    await forceTheme(page, "dark");
    await page.goto("/");
    await expect(page.locator(".cit-brand")).toBeVisible();
    await openCommandPalette(page);
    await page.screenshot({ path: `docs/campaigns/theme-dark-${testInfo.project.name}-cockpit.png`, fullPage: true });

    const offenders = await collectOffenders(page, PURE_WHITE_OFFENDER);
    expect(offenders, `Pure-white backgrounds leaked into dark mode: ${JSON.stringify(offenders, null, 2)}`).toEqual(
      [],
    );
  });

  test("settings route inherits both themes cleanly", async ({ page }, testInfo) => {
    await forceTheme(page, "light");
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.screenshot({ path: `docs/campaigns/theme-light-${testInfo.project.name}-settings.png`, fullPage: true });
    expect(await collectOffenders(page, DARK_SLATE_OFFENDERS)).toEqual([]);
    expect(await collectOffenders(page, COOL_WHITE_OFFENDERS_LIGHT)).toEqual([]);

    await forceTheme(page, "dark");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await page.screenshot({ path: `docs/campaigns/theme-dark-${testInfo.project.name}-settings.png`, fullPage: true });
    expect(await collectOffenders(page, PURE_WHITE_OFFENDER)).toEqual([]);
  });

  test("theme button cycles light → dark → system across three clicks", async ({ page }) => {
    // Start from light so the cycle is observable: light → dark → system → light.
    await forceTheme(page, "light");
    await page.goto("/settings");
    const themeButton = page.getByRole("button", { name: /^Theme: /i });
    await expect(themeButton).toBeVisible();

    // Light → Dark
    await expect(themeButton).toHaveAttribute("aria-label", /Theme: Light\. Click for Dark\./);
    await themeButton.click();
    await expect(themeButton).toHaveAttribute("aria-label", /Theme: Dark\. Click for System\./);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("citadel.theme"))).toBe("dark");

    // Dark → System (the data-theme attribute should be removed; resolved theme
    // is then governed by matchMedia, not asserted here)
    await themeButton.click();
    await expect(themeButton).toHaveAttribute("aria-label", /Theme: System\. Click for Light\./);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBeUndefined();
    expect(await page.evaluate(() => localStorage.getItem("citadel.theme"))).toBe("system");

    // System → Light (full loop)
    await themeButton.click();
    await expect(themeButton).toHaveAttribute("aria-label", /Theme: Light\. Click for Dark\./);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(await page.evaluate(() => localStorage.getItem("citadel.theme"))).toBe("light");
  });
});
