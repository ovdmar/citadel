import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CitadelConfigSchema,
  RuntimeConfigSchema,
  UsageProviderConfigSchema,
  defaultConfigPath,
  detectWorktree,
  loadConfig,
  mergeConfigPatch,
  saveConfig,
} from "./index.js";

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

  it("in worktree mode, ignores dataDir/databasePath stored in the raw config file and derives them from env", () => {
    // Worktree-isolation regression: if a worktree daemon accidentally reads a
    // config file that has `dataDir` pointing at the prod install (e.g. via a
    // leaked CITADEL_CONFIG env var), the saved paths MUST NOT override the
    // env-derived defaults. Otherwise the worktree daemon writes to prod data.
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-iso-"));
    dirs.push(root);
    const worktreeDataDir = path.join(root, "worktree-data");
    process.env.CITADEL_DATA_DIR = worktreeDataDir;
    process.env.CITADEL_WORKTREE = "1";
    const configPath = path.join(root, "leaked.config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: "/home/prod/.local/share/citadel",
        databasePath: "/home/prod/.local/share/citadel/citadel.sqlite",
        port: 4010,
      }),
    );
    try {
      const loaded = loadConfig(configPath);
      expect(loaded.dataDir).toBe(worktreeDataDir);
      expect(loaded.databasePath).toBe(path.join(worktreeDataDir, "citadel.sqlite"));
      // Non-path keys (port, providers, etc.) still come from the file.
      expect(loaded.port).toBe(4010);
    } finally {
      // biome-ignore lint/performance/noDelete: `delete` is the only real way to unset a process.env key.
      if (prevData === undefined) delete process.env.CITADEL_DATA_DIR;
      else process.env.CITADEL_DATA_DIR = prevData;
      // biome-ignore lint/performance/noDelete: same — must actually unset.
      if (prevWorktree === undefined) delete process.env.CITADEL_WORKTREE;
      else process.env.CITADEL_WORKTREE = prevWorktree;
    }
  });

  it("in prod mode (no CITADEL_WORKTREE), honors dataDir/databasePath persisted in the config file", () => {
    // Prod regression: the systemd-supervised daemon at the main install must
    // be able to persist a customized `databasePath` in
    // `~/.local/share/citadel/citadel.config.json` and have it actually take
    // effect. Without this, the worktree-isolation strip would silently route
    // the prod daemon to the env-derived default dir, stranding the operator's
    // real data.
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-prod-"));
    dirs.push(root);
    const customDataDir = path.join(root, "custom-data");
    const customDbPath = path.join(customDataDir, "citadel.sqlite");
    // biome-ignore lint/performance/noDelete: must actually clear these for the env-derived defaults to fall back to the home XDG path.
    delete process.env.CITADEL_DATA_DIR;
    // biome-ignore lint/performance/noDelete: ensure we're not in worktree mode.
    delete process.env.CITADEL_WORKTREE;
    const configPath = path.join(root, "prod.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: customDataDir,
        databasePath: customDbPath,
        port: 4010,
      }),
    );
    try {
      const loaded = loadConfig(configPath);
      expect(loaded.dataDir).toBe(customDataDir);
      expect(loaded.databasePath).toBe(customDbPath);
      expect(loaded.port).toBe(4010);
    } finally {
      if (prevData !== undefined) process.env.CITADEL_DATA_DIR = prevData;
      if (prevWorktree !== undefined) process.env.CITADEL_WORKTREE = prevWorktree;
    }
  });
});

describe("providerRefresh schema", () => {
  function parseWith(refresh: unknown) {
    return CitadelConfigSchema.parse({
      dataDir: "/tmp/citadel-test",
      databasePath: "/tmp/citadel-test/db.sqlite",
      providerRefresh: refresh,
    });
  }

  it("default-fills the full providerRefresh block when omitted", () => {
    const config = CitadelConfigSchema.parse({
      dataDir: "/tmp/citadel-test",
      databasePath: "/tmp/citadel-test/db.sqlite",
    });
    expect(config.providerRefresh.enabled).toBe(true);
    expect(config.providerRefresh.workingHours.startHour).toBe(9);
    expect(config.providerRefresh.workingHours.endHour).toBe(18);
    expect(config.providerRefresh.workingHours.weekdaysOnly).toBe(true);
    expect(config.providerRefresh.intervals.prCiMs).toBe(60_000);
    expect(config.providerRefresh.intervals.jiraMs).toBe(5 * 60_000);
    expect(config.providerRefresh.intervals.usageMs).toBe(5 * 60_000);
    expect(config.providerRefresh.focusRefreshThresholdMs).toBe(30_000);
    expect(config.providerRefresh.maxConcurrentRefreshes).toBe(4);
  });

  it("rejects workingHours.startHour below 0 or above 23", () => {
    expect(() => parseWith({ workingHours: { startHour: -1 } })).toThrow();
    expect(() => parseWith({ workingHours: { startHour: 24 } })).toThrow();
  });

  it("rejects workingHours.endHour below 0 or above 24", () => {
    expect(() => parseWith({ workingHours: { endHour: -1 } })).toThrow();
    expect(() => parseWith({ workingHours: { endHour: 25 } })).toThrow();
  });

  it("rejects intervals below their respective minima", () => {
    expect(() => parseWith({ intervals: { prCiMs: 14_999 } })).toThrow();
    expect(() => parseWith({ intervals: { jiraMs: 29_999 } })).toThrow();
    expect(() => parseWith({ intervals: { usageMs: 29_999 } })).toThrow();
  });

  it("rejects focusRefreshThresholdMs below 5s", () => {
    expect(() => parseWith({ focusRefreshThresholdMs: 4_999 })).toThrow();
  });

  it("rejects maxConcurrentRefreshes outside 1..16", () => {
    expect(() => parseWith({ maxConcurrentRefreshes: 0 })).toThrow();
    expect(() => parseWith({ maxConcurrentRefreshes: 17 })).toThrow();
  });

  it("accepts enabled:false to disable the job", () => {
    const config = parseWith({ enabled: false });
    expect(config.providerRefresh.enabled).toBe(false);
  });
});

describe("UsageProviderConfig.refreshIntervalMs", () => {
  it("is optional and absent by default", () => {
    const parsed = UsageProviderConfigSchema.parse({
      id: "p1",
      runtimeId: "claude-code",
      command: "/bin/true",
    });
    expect(parsed.refreshIntervalMs).toBeUndefined();
  });

  it("accepts values >= 30s", () => {
    const parsed = UsageProviderConfigSchema.parse({
      id: "p1",
      runtimeId: "claude-code",
      command: "/bin/true",
      refreshIntervalMs: 30_000,
    });
    expect(parsed.refreshIntervalMs).toBe(30_000);
  });

  it("rejects values below 30s", () => {
    expect(() =>
      UsageProviderConfigSchema.parse({
        id: "p1",
        runtimeId: "claude-code",
        command: "/bin/true",
        refreshIntervalMs: 29_999,
      }),
    ).toThrow();
  });
});

describe("RuntimeConfig contract surface (regression guard)", () => {
  // We deliberately do NOT widen RuntimeConfigSchema with a per-runtime usage
  // cadence override — that field belongs on UsageProviderConfigSchema. This
  // negative guard catches a future drive-by addition that would silently
  // cascade across ~19 consumers (web settings, MCP, agent session creation).
  it("does NOT contain usageRefreshIntervalMs", () => {
    const shape = RuntimeConfigSchema.shape;
    expect(shape).not.toHaveProperty("usageRefreshIntervalMs");
  });
});
