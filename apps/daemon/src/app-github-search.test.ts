import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeServer, createFixture as createFixtureBase, getJson, listen } from "./app-test-helpers.js";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";
process.env.CITADEL_DISABLE_TERMINAL_REAPER = "1";

const createFixture = () => createFixtureBase(dirs);

describe("createDaemonApp - GitHub search", () => {
  it("searches GitHub repositories through gh api REST", async () => {
    const fixture = createFixture();
    const fakeGh = path.join(fixture.config.dataDir, "fake-gh");
    const argsPath = path.join(fixture.config.dataDir, "gh-args.txt");
    fs.writeFileSync(
      fakeGh,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${argsPath}"
cat <<'JSON'
{"items":[{"full_name":"octo/repo","html_url":"https://github.com/octo/repo","description":"Demo repo","default_branch":"main"},{"full_name":"octo/empty","html_url":"https://github.com/octo/empty","description":null,"default_branch":null}]}
JSON
`,
      { mode: 0o755 },
    );
    fixture.config.providers.github = { enabled: true, command: fakeGh };
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const search = await getJson<{
        results: Array<{ name: string; url: string; description?: string; defaultBranch?: string }>;
      }>(`${baseUrl}/api/integrations/github/search?q=${encodeURIComponent("octo")}`);

      expect(search.results).toEqual([
        {
          name: "octo/repo",
          url: "https://github.com/octo/repo",
          description: "Demo repo",
          defaultBranch: "main",
        },
        {
          name: "octo/empty",
          url: "https://github.com/octo/empty",
        },
      ]);
      const args = fs.readFileSync(argsPath, "utf8").trim().split("\n");
      expect(args.slice(0, 4)).toEqual(["api", "--method", "GET", "search/repositories"]);
      expect(args).toContain("q=octo");
      expect(args).toContain("per_page=8");
      expect(args).not.toContain("graphql");
    } finally {
      await closeServer(server);
    }
  });
});
