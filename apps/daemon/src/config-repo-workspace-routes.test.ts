import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, createGitRepo, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

describe("config/repo/workspace routes", () => {
  it("completes filesystem paths for the add-repo autocomplete", async () => {
    const fixture = createFixtureBase(dirs);
    const { repoPath } = createGitRepo(fixture.config.dataDir);
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const parent = path.dirname(repoPath);
      const basename = path.basename(repoPath);
      const dirPrefix = `${parent}/`;
      const dirListing = await getJson<{
        baseDir: string;
        entries: Array<{ name: string; path: string; isGit: boolean }>;
      }>(`${baseUrl}/api/fs/complete?prefix=${encodeURIComponent(dirPrefix)}`);
      expect(dirListing.baseDir).toBe(path.resolve(parent));
      const match = dirListing.entries.find((entry) => entry.name === basename);
      expect(match).toBeTruthy();
      expect(match?.isGit).toBe(true);

      const filtered = await getJson<{ entries: Array<{ name: string; isGit: boolean }> }>(
        `${baseUrl}/api/fs/complete?prefix=${encodeURIComponent(path.join(parent, basename.slice(0, 1)))}`,
      );
      expect(filtered.entries.find((entry) => entry.name === basename)).toBeTruthy();

      const tilde = await getJson<{ baseDir: string }>(`${baseUrl}/api/fs/complete?prefix=~%2F`);
      expect(tilde.baseDir).toBe(os.homedir());
    } finally {
      await closeServer(server);
    }
  });
});
