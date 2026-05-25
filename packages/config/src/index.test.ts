import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfigPath, detectWorktree, loadConfig, mergeConfigPatch, saveConfig } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("creates a default local-first config when missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");

    const config = loadConfig(configPath);

    expect(config.version).toBe(1);
    expect(config.mcp.enabled).toBe(true);
    expect(config.runtimes.map((runtime) => runtime.id)).toContain("shell");
    expect(config.usageProviders).toEqual([]);
    expect(fs.existsSync(configPath)).toBe(true);
  });

  it("validates static hooks and repo defaults", () => {
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
        repoDefaults: { setupHookIds: ["setup"] },
      }),
    );

    const config = loadConfig(configPath);

    expect(config.hooks[0]?.id).toBe("setup");
    expect(config.hooks[0]?.kind).toBe("command");
    expect(config.repoDefaults.setupHookIds).toEqual(["setup"]);
  });

  it("defaults lifecycle notification hooks to non-blocking", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        hooks: [{ id: "notify", event: "workspace.created", command: "true" }],
      }),
    );

    const config = loadConfig(configPath);

    expect(config.hooks[0]).toMatchObject({ id: "notify", blocking: false });
  });

  it("rejects hook references that are missing or wired to the wrong event", () => {
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
        repoDefaults: { setupHookIds: ["missing"], teardownHookIds: ["setup"] },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow(/Unknown hook id|not workspace.teardown/);
  });

  it("rejects malformed command hook cwd values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        hooks: [{ id: "setup", event: "workspace.setup", command: "true", cwd: "relative/path" }],
      }),
    );

    expect(() => loadConfig(configPath)).toThrow("Hook cwd must be an absolute path");
  });

  it("detectWorktree resolves a git worktree to its name (via .git file pointing under main/.git/worktrees)", () => {
    // Simulate a layout: <root>/main has a .git directory, <root>/wt-foo has a
    // .git file pointing at <root>/main/.git/worktrees/wt-foo.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-worktree-"));
    dirs.push(root);
    const mainGit = path.join(root, "main", ".git");
    fs.mkdirSync(path.join(mainGit, "worktrees", "wt-foo"), { recursive: true });
    const worktreeDir = path.join(root, "wt-foo");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${path.join(mainGit, "worktrees", "wt-foo")}\n`);

    expect(detectWorktree(worktreeDir)).toEqual({
      name: "wt-foo",
      gitDir: path.join(mainGit, "worktrees", "wt-foo"),
    });
    // The main repo (where .git is a directory) is NOT a worktree.
    expect(detectWorktree(path.join(root, "main"))).toBeNull();
  });

  it("defaultConfigPath scopes to <dataDir>/worktrees/<name> when cwd is inside a worktree", () => {
    // CITADEL_CONFIG overrides everything; clear it to exercise the auto path.
    const prevConfig = process.env.CITADEL_CONFIG;
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevCwd = process.cwd();
    // biome-ignore lint/performance/noDelete: `delete` is the only real way to unset a process.env key — `= undefined` coerces to "undefined".
    delete process.env.CITADEL_CONFIG;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scope-"));
    dirs.push(root);
    const dataDir = path.join(root, "data");
    process.env.CITADEL_DATA_DIR = dataDir;
    const mainGit = path.join(root, "repo", ".git");
    fs.mkdirSync(path.join(mainGit, "worktrees", "feat-x"), { recursive: true });
    const worktreeDir = path.join(root, "feat-x");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${path.join(mainGit, "worktrees", "feat-x")}\n`);
    try {
      process.chdir(worktreeDir);
      expect(defaultConfigPath()).toBe(path.join(dataDir, "worktrees", "feat-x", "citadel.config.json"));
    } finally {
      process.chdir(prevCwd);
      // biome-ignore lint/performance/noDelete: `delete` is the only real way to unset a process.env key.
      if (prevConfig === undefined) delete process.env.CITADEL_CONFIG;
      else process.env.CITADEL_CONFIG = prevConfig;
      // biome-ignore lint/performance/noDelete: see above.
      if (prevData === undefined) delete process.env.CITADEL_DATA_DIR;
      else process.env.CITADEL_DATA_DIR = prevData;
    }
  });

  it("defaultConfigPath honors CITADEL_CONFIG even when cwd is a worktree (production path is sacred)", () => {
    const prevConfig = process.env.CITADEL_CONFIG;
    const prevCwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scope-"));
    dirs.push(root);
    const mainGit = path.join(root, "repo", ".git");
    fs.mkdirSync(path.join(mainGit, "worktrees", "feat-y"), { recursive: true });
    const worktreeDir = path.join(root, "feat-y");
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, ".git"), `gitdir: ${path.join(mainGit, "worktrees", "feat-y")}\n`);
    const explicit = path.join(root, "production-config.json");
    process.env.CITADEL_CONFIG = explicit;
    try {
      process.chdir(worktreeDir);
      expect(defaultConfigPath()).toBe(explicit);
    } finally {
      process.chdir(prevCwd);
      // biome-ignore lint/performance/noDelete: see above.
      if (prevConfig === undefined) delete process.env.CITADEL_CONFIG;
      else process.env.CITADEL_CONFIG = prevConfig;
    }
  });

  it("merges and saves operator config updates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    const current = loadConfig(configPath);

    const next = mergeConfigPatch(current, {
      mcp: { enabled: false },
      providers: { github: { enabled: true }, jira: { enabled: false } },
      usageProviders: [{ id: "usage-shell", runtimeId: "shell", command: "node", args: ["usage.js"] }],
      hooks: [{ id: "setup", event: "workspace.setup", command: "node", args: ["setup.js"], blocking: false }],
      repoDefaults: { setupHookIds: ["setup"], teardownHookIds: [] },
    });
    saveConfig(next, configPath);

    const reloaded = loadConfig(configPath);
    expect(reloaded.mcp.enabled).toBe(false);
    expect(reloaded.providers.jira.enabled).toBe(false);
    expect(reloaded.usageProviders[0]).toMatchObject({ id: "usage-shell", runtimeId: "shell" });
    expect(reloaded.hooks[0]).toMatchObject({ id: "setup", blocking: false });
    expect(reloaded.repoDefaults.setupHookIds).toEqual(["setup"]);
  });
});
