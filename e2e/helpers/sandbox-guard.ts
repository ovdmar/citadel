import type { APIRequestContext } from "@playwright/test";
import { apiGet } from "./api-request.js";

// Last line of defense against the e2e suite writing into a production install.
//
// Historically a Playwright run could end up reusing a real cockpit daemon
// (default port 4012 matched the user's prod config; `reuseExistingServer:
// true` made Playwright skip launching its own sandboxed daemon) — the suite
// then PUT fixture content into the user's actual scratchpad and clobbered
// real notes. The port and reuse defaults are now fixed in
// `playwright.config.ts`, and this guard fails the run loudly if any of those
// defenses gets undone in future.
//
// The check is cheap and runs from a Playwright setup dependency so a
// misconfigured run aborts before any destructive PUT happens.
export async function assertDaemonIsSandbox(request: APIRequestContext, apiBase: string): Promise<void> {
  const expectedPrefix =
    process.env.CITADEL_PLAYWRIGHT_SANDBOX_PREFIX ||
    process.env.CITADEL_PLAYWRIGHT_DATA_DIR ||
    "/tmp/citadel-playwright-data";
  const expectedRunId = process.env.CITADEL_PLAYWRIGHT_RUN_ID;
  if (!expectedRunId) {
    throw new Error("[sandbox-guard] missing CITADEL_PLAYWRIGHT_RUN_ID. Refusing to run destructive e2e tests.");
  }
  const res = await apiGet(request, `${apiBase}/api/health`);
  if (!res.ok()) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[sandbox-guard] could not verify ${apiBase}/api/health (status ${res.status()}). Refusing to run destructive tests against an unknown daemon.${detail ? ` Response: ${detail}` : ""}`,
    );
  }
  const body = (await res.json()) as {
    databasePath?: string;
    e2e?: { enabled?: boolean; runId?: string; dataDir?: string };
  };
  if (body.e2e?.enabled !== true || body.e2e.runId !== expectedRunId) {
    throw new Error(
      `[sandbox-guard] daemon at ${apiBase} did not echo the expected Playwright run id. Refusing to run — the target is not the daemon launched for this e2e run.`,
    );
  }
  const dbPath = body.databasePath;
  if (typeof dbPath !== "string" || !dbPath.startsWith(expectedPrefix)) {
    throw new Error(
      `[sandbox-guard] daemon at ${apiBase} reports databasePath=${dbPath ?? "<missing>"}, which is not under ${expectedPrefix}. Refusing to run — this would overwrite real user data (see incident 2026-05-27: e2e suite clobbered ~/.local/share/citadel/scratchpad.md). If this is intentional, set CITADEL_PLAYWRIGHT_SANDBOX_PREFIX to a prefix that matches the target daemon's data dir.`,
    );
  }
}
