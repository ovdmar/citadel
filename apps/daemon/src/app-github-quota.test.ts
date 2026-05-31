import fs from "node:fs";
import path from "node:path";
import { clearGhCooldown, setGhCooldown } from "@citadel/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

beforeEach(() => {
  clearGhCooldown();
});

afterEach(() => {
  clearGhCooldown();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

const createFixture = () => createFixtureBase(dirs);

describe("createDaemonApp — GitHub quota", () => {
  it("reports GitHub quota automation disabled for worktree daemons without shelling out", async () => {
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const prevAutomated = process.env.CITADEL_AUTOMATED_GH;
    const prevWorktreeGh = process.env.CITADEL_ENABLE_WORKTREE_GH_AUTOMATION;
    process.env.CITADEL_WORKTREE = "1";
    Reflect.deleteProperty(process.env, "CITADEL_AUTOMATED_GH");
    Reflect.deleteProperty(process.env, "CITADEL_ENABLE_WORKTREE_GH_AUTOMATION");
    const fixture = createFixture();
    fixture.config.providers.github.command = "definitely-missing-gh";
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{ quota: { status: string; automationEnabled: boolean; reason: string } }>(
        `${baseUrl}/api/integrations/github/quota`,
      );
      expect(body.quota).toMatchObject({
        status: "unavailable",
        automationEnabled: false,
      });
      expect(body.quota.reason).toContain("Automated GitHub polling is disabled");
    } finally {
      await closeServer(server);
      if (prevWorktree === undefined) Reflect.deleteProperty(process.env, "CITADEL_WORKTREE");
      else process.env.CITADEL_WORKTREE = prevWorktree;
      if (prevAutomated === undefined) Reflect.deleteProperty(process.env, "CITADEL_AUTOMATED_GH");
      else process.env.CITADEL_AUTOMATED_GH = prevAutomated;
      if (prevWorktreeGh === undefined) Reflect.deleteProperty(process.env, "CITADEL_ENABLE_WORKTREE_GH_AUTOMATION");
      else process.env.CITADEL_ENABLE_WORKTREE_GH_AUTOMATION = prevWorktreeGh;
    }
  }, 15_000);

  it("keeps GitHub quota resources visible while gh automation is cooling down", async () => {
    const fixture = createFixture();
    const fakeGh = path.join(fixture.config.dataDir, "fake-gh");
    const logPath = path.join(fixture.config.dataDir, "fake-gh.log");
    fs.writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
echo "$*" >> "${logPath}"
if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then
  cat <<'JSON'
{"resources":{"core":{"limit":5000,"used":25,"remaining":4975,"reset":1770000000},"graphql":{"limit":5000,"used":5000,"remaining":0,"reset":1770000300},"search":{"limit":30,"used":0,"remaining":30,"reset":1770000600}}}
JSON
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    fixture.config.providers.github.enabled = true;
    fixture.config.providers.github.command = fakeGh;
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const until = setGhCooldown("GraphQL: API rate limit already exceeded", 60_000);
      const first = await getJson<{
        quota: {
          status: string;
          cooldownUntil: string | null;
          resources: Array<{ name: string; percentUsed: number }>;
        };
      }>(`${baseUrl}/api/integrations/github/quota`);
      expect(first.quota).toMatchObject({
        status: "degraded",
        cooldownUntil: new Date(until).toISOString(),
      });
      expect(first.quota.resources.find((resource) => resource.name === "graphql")).toMatchObject({
        percentUsed: 100,
      });

      await getJson(`${baseUrl}/api/integrations/github/quota`);
      const calls = fs.readFileSync(logPath, "utf8").trim().split("\n");
      expect(calls).toEqual(["api rate_limit"]);
    } finally {
      clearGhCooldown();
      await closeServer(server);
    }
  }, 15_000);

  it("starts GitHub cooldown from an exhausted quota response before PR polling retries", async () => {
    const fixture = createFixture();
    const fakeGh = path.join(fixture.config.dataDir, "fake-gh");
    fs.writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
if [ "$1" = "api" ] && [ "$2" = "rate_limit" ]; then
  cat <<'JSON'
{"resources":{"core":{"limit":5000,"used":25,"remaining":4975,"reset":4102444800},"graphql":{"limit":5000,"used":5000,"remaining":0,"reset":4102444800},"search":{"limit":30,"used":0,"remaining":30,"reset":4102444800}}}
JSON
  exit 0
fi
exit 1
`,
      { mode: 0o755 },
    );
    fixture.config.providers.github.enabled = true;
    fixture.config.providers.github.command = fakeGh;
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const body = await getJson<{
        quota: {
          status: string;
          reason: string | null;
          cooldownUntil: string | null;
          resources: Array<{ name: string; percentUsed: number }>;
        };
      }>(`${baseUrl}/api/integrations/github/quota`);
      expect(body.quota.status).toBe("degraded");
      expect(body.quota.reason).toContain("GitHub graphql quota exhausted");
      expect(body.quota.cooldownUntil).toBeTruthy();
      expect(body.quota.resources.find((resource) => resource.name === "graphql")).toMatchObject({
        percentUsed: 100,
      });
    } finally {
      clearGhCooldown();
      await closeServer(server);
    }
  }, 15_000);

  it("injects versionControl.cooldownUntil into provider-summary while gh is in cooldown (review #6)", async () => {
    const fixture = createFixture();
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_cooldown",
      name: "Cooldown Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => ({
          providerId: "github-gh",
          status: "healthy" as const,
          reason: null,
          defaultBranch: "main",
          currentBranch: "main",
          remotes: ["origin"],
          pullRequest: null,
          checkedAt: new Date().toISOString(),
        }),
      },
    });
    const baseUrl = await listen(server);
    try {
      const before = await getJson<{ versionControl: { cooldownUntil?: string | null } }>(
        `${baseUrl}/api/repos/repo_cooldown/provider-summary`,
      );
      expect(before.versionControl.cooldownUntil).toBeUndefined();
      const until = setGhCooldown("API rate limit exceeded for user ID 1", 60_000);
      const during = await getJson<{ versionControl: { cooldownUntil?: string | null } }>(
        `${baseUrl}/api/repos/repo_cooldown/provider-summary`,
      );
      expect(during.versionControl.cooldownUntil).toBe(new Date(until).toISOString());
    } finally {
      clearGhCooldown();
      await closeServer(server);
    }
  }, 15_000);
});
