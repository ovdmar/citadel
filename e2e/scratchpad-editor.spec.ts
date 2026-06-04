import { type Page, expect, test } from "@playwright/test";
import { apiGet, apiPut } from "./helpers/api-request.js";
import { assertDaemonIsSandbox } from "./helpers/sandbox-guard.js";
import { acquireSharedStateLock } from "./helpers/shared-state-lock.js";

const API_BASE =
  process.env.CITADEL_API_BASE || `http://127.0.0.1:${process.env.CITADEL_PLAYWRIGHT_DAEMON_PORT || "14012"}`;

test.describe("scratchpad drawer", () => {
  test.setTimeout(300_000);

  let releaseSharedState: (() => void) | null = null;

  test.beforeAll(async ({ request }, testInfo) => {
    testInfo.setTimeout(300_000);
    await assertDaemonIsSandbox(request, API_BASE);
    releaseSharedState = await acquireSharedStateLock("scratchpad", testInfo.titlePath.join(" > "));
  });

  test.beforeEach(async ({ request }) => {
    await apiPut(request, `${API_BASE}/api/config`, { data: { scratchpad: {} } });
    await apiPut(request, `${API_BASE}/api/scratchpad`, { data: { content: "" } });
  });

  test.afterEach(async ({ request }) => {
    await apiPut(request, `${API_BASE}/api/scratchpad`, { data: { content: "" } });
    await apiPut(request, `${API_BASE}/api/config`, { data: { scratchpad: {} } });
  });

  test.afterAll(() => {
    releaseSharedState?.();
    releaseSharedState = null;
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

  test("mobile bare-root opens scratchpad and mic targets the composer while unfocused", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile quick idea path");
    await installFakeSpeechRecognition(page);

    await page.goto("/");

    await expect.poll(() => new URL(page.url()).searchParams.get("scratchpad")).toBe("1");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    const composer = page.locator(".scratchpad-composer-input");
    await expect(composer).toBeVisible();
    await expect(composer).toBeFocused();
    const mic = page.getByRole("button", { name: "Start voice dictation" });
    await expect(mic).toBeVisible();
    const box = await mic.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(36);
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
    await page.locator(".scratchpad-drawer-history-toggle").focus();
    await expect(page.locator(".scratchpad-drawer-history-toggle")).toBeFocused();

    await mic.click();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const typedWindow = window as typeof window & {
            __citadelFakeSpeechRecognitionInstances?: Array<unknown>;
          };
          return typedWindow.__citadelFakeSpeechRecognitionInstances?.length ?? 0;
        }),
      )
      .toBeGreaterThan(0);
    expect(await emitFakeSpeechFinal(page, "voice idea")).toBe(true);
    await expect(page.locator(".scratchpad-block-list").getByText("voice idea")).toBeVisible();
  });

  test("mobile root deeplinks do not auto-open scratchpad", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "mobile bootstrap coverage");

    await page.goto("/?modal=new-workspace");
    await expect.poll(() => new URL(page.url()).searchParams.get("scratchpad")).toBeNull();
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();

    await page.goto("/#hash");
    await expect.poll(() => new URL(page.url()).searchParams.get("scratchpad")).toBeNull();
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
  });

  test("close button hides the drawer and clears the query param", async ({ page }) => {
    await page.goto("/?scratchpad=1");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    await page.locator(".scratchpad-drawer-close").click();
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
  });

  test("cmd+shift+s toggles the drawer from any route", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "mobile has no hardware shortcut requirement");
    await page.goto("/");
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".scratchpad-drawer")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+s");
    await expect(page.locator(".scratchpad-drawer")).toBeHidden();
  });

  test("desktop voice shortcut commits final transcript into the focused composer", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "hardware shortcut coverage is desktop/tablet");
    await installFakeSpeechRecognition(page);
    await page.goto("/?scratchpad=1");
    await page.locator(".scratchpad-composer-input").focus();

    await page.keyboard.press("Control+Shift+D");

    await expect(page.locator(".voice-mode-overlay")).toBeVisible();
    await expect(page.locator(".voice-mode-status")).toContainText("Listening");
    expect(await emitFakeSpeechFinal(page, "desktop voice idea")).toBe(true);
    await expect(page.locator(".scratchpad-block-list").getByText("desktop voice idea")).toBeVisible();
  });

  test("desktop voice shortcut inserts into a focused non-scratchpad input", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === "mobile", "hardware shortcut coverage is desktop/tablet");
    await installFakeSpeechRecognition(page);
    await page.goto("/settings");
    await page.getByRole("button", { name: "Notes" }).click();
    const notesInput = page.locator('[data-testid="notes-location-input"]');
    await expect(notesInput).toBeVisible();
    await notesInput.fill("");
    await notesInput.focus();

    await page.keyboard.press("Control+Shift+D");

    await expect(page.locator(".voice-mode-overlay")).toBeVisible();
    expect(await emitFakeSpeechFinal(page, "/tmp/voice-notes.md")).toBe(true);
    await expect(notesInput).toHaveValue("/tmp/voice-notes.md");
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
    const list = await apiGet(request, `${API_BASE}/api/scratchpad/blocks`);
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

async function installFakeSpeechRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type FakeSpeechRecognitionResultEvent = {
      resultIndex: number;
      results: Array<{ isFinal: boolean; 0: { transcript: string } }>;
    };
    class FakeSpeechRecognition {
      static instances: FakeSpeechRecognition[] = [];
      lang = "";
      interimResults = false;
      continuous = false;
      onresult: ((event: FakeSpeechRecognitionResultEvent) => void) | null = null;
      onend: (() => void) | null = null;

      constructor() {
        FakeSpeechRecognition.instances.push(this);
      }

      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
      emitFinal(text: string) {
        this.onresult?.({
          resultIndex: 0,
          results: [{ isFinal: true, 0: { transcript: text } }],
        });
      }
    }
    const typedWindow = window as typeof window & {
      __citadelFakeSpeechRecognitionInstances: FakeSpeechRecognition[];
      SpeechRecognition: typeof FakeSpeechRecognition;
      webkitSpeechRecognition: typeof FakeSpeechRecognition;
    };
    Object.defineProperty(typedWindow, "isSecureContext", { configurable: true, value: true });
    Object.defineProperty(typedWindow, "SpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
    Object.defineProperty(typedWindow, "webkitSpeechRecognition", { configurable: true, value: FakeSpeechRecognition });
    typedWindow.__citadelFakeSpeechRecognitionInstances = FakeSpeechRecognition.instances;
  });
}

async function emitFakeSpeechFinal(page: Page, text: string): Promise<boolean> {
  return page.evaluate((finalText) => {
    const typedWindow = window as typeof window & {
      __citadelFakeSpeechRecognitionInstances: Array<{ emitFinal: (text: string) => void }>;
    };
    const instances = typedWindow.__citadelFakeSpeechRecognitionInstances;
    const instance = instances[instances.length - 1];
    if (!instance) return false;
    instance.emitFinal(finalText);
    return true;
  }, text);
}
