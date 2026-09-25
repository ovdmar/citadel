import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("workspace.requestReview config", () => {
  it("defaults workspace.requestReview hooks to blocking", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        hooks: [{ id: "review", event: "workspace.requestReview", command: "true" }],
        repoDefaults: { requestReviewHookIds: ["review"] },
      }),
    );

    const config = loadConfig(configPath);

    expect(config.hooks[0]).toMatchObject({ id: "review", blocking: true });
    expect(config.repoDefaults.requestReviewHookIds).toEqual(["review"]);
  });

  it("rejects requestReviewHookIds pointing at a non-review hook", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        hooks: [{ id: "setup", event: "workspace.setup", command: "true" }],
        repoDefaults: { requestReviewHookIds: ["setup"] },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/workspace.requestReview/);
  });

  it("defaults requestReviewHookIds to empty when omitted from existing configs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        hooks: [],
        repoDefaults: { setupHookIds: [] },
      }),
    );

    const config = loadConfig(configPath);

    expect(config.repoDefaults.requestReviewHookIds).toEqual([]);
  });
});
