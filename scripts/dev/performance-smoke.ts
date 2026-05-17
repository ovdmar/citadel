import { chromium } from "@playwright/test";

const apiBaseUrl = process.env.CITADEL_BASE_URL || "http://127.0.0.1:4337";
const webBaseUrl = process.env.CITADEL_WEB_URL || "http://127.0.0.1:5173";

const state = await time("api_state", 2000, async () => {
  const response = await fetch(`${apiBaseUrl}/api/state`);
  if (!response.ok) throw new Error(`/api/state returned ${response.status}`);
  return response.json() as Promise<{ repos: Array<{ id: string }> }>;
});

if (state.result.repos[0]) {
  await time("provider_summary", 5000, async () => {
    const response = await fetch(`${apiBaseUrl}/api/repos/${state.result.repos[0]?.id}/provider-summary`);
    if (!response.ok) throw new Error(`/api/repos/:id/provider-summary returned ${response.status}`);
    return response.json();
  });
}

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await time("web_cockpit_visible", 2000, async () => {
    await page.goto(webBaseUrl);
    await page.getByRole("heading", { name: "Operations" }).waitFor();
    await page.getByRole("heading", { name: "Workspace Board" }).waitFor();
  });
  await time("workspace_settings_switch", 1000, async () => {
    await page.getByRole("link", { name: /settings/i }).click();
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await page.getByRole("link", { name: /workspaces/i }).click();
    await page.getByRole("heading", { name: "Operations" }).waitFor();
  });
} finally {
  await browser.close();
}

async function time<T>(name: string, maxMs: number, fn: () => Promise<T>) {
  const start = performance.now();
  const result = await fn();
  const durationMs = Math.round(performance.now() - start);
  console.log(`${name} ${durationMs}ms`);
  if (durationMs > maxMs) throw new Error(`${name} exceeded ${maxMs}ms`);
  return { durationMs, result };
}
