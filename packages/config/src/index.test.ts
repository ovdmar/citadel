import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CitadelConfigSchema,
  RuntimeConfigSchema,
  UsageProviderConfigSchema,
  defaultConfigPath,
  defaultNotesPath,
  detectWorktree,
  effectiveNotesPath,
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
    expect(config.runtimes.find((runtime) => runtime.id === "codex")?.args).toEqual(["--yolo", "--enable", "goals"]);
    expect(config.usageProviders).toEqual([]);
    expect(config.automations.fixCi).toMatchObject({
      enabled: true,
      runtimeId: "claude-code",
      fallbackRuntimeId: "codex",
      idleThresholdMs: 300_000,
      debounceMs: 1_800_000,
      intervalMs: 60_000,
    });
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
      automations: { fixCi: { enabled: true, runtimeId: "codex", fallbackRuntimeId: "cursor-agent" } },
      hooks: [{ id: "setup", event: "workspace.setup", command: "node", args: ["setup.js"], blocking: false }],
      repoDefaults: { setupHookIds: ["setup"], teardownHookIds: [] },
    });
    saveConfig(next, configPath);

    const reloaded = loadConfig(configPath);
    expect(reloaded.mcp.enabled).toBe(false);
    expect(reloaded.providers.jira.enabled).toBe(false);
    expect(reloaded.usageProviders[0]).toMatchObject({ id: "usage-shell", runtimeId: "shell" });
    expect(reloaded.automations.fixCi).toMatchObject({
      enabled: true,
      runtimeId: "codex",
      fallbackRuntimeId: "cursor-agent",
      idleThresholdMs: 300_000,
    });
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

  it("backfills missing runtime fields from built-in defaults so stale on-disk configs keep resume support", () => {
    // Regression: a config file written before `resumeArg`/`sessionIdArg`/
    // `supportsResume` were added to RuntimeConfigSchema would persist a
    // claude-code entry without them. On reload, the top-level `runtimes`
    // array fully replaced the schema's default array, so the built-in
    // resume fields were lost — and the restore route then rejected every
    // claude session with `runtime_does_not_support_resume`. We backfill
    // missing fields per-id from built-ins; user overrides still win.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        runtimes: [
          // Pre-schema-evolution shape: no resumeArg, no supportsResume, etc.
          { id: "claude-code", displayName: "Claude Code", command: "claude", args: [] },
          // User override that should be preserved over the built-in.
          { id: "shell", displayName: "Custom Shell", command: "zsh", args: [] },
          // Unknown id — left untouched (it's a user-defined custom runtime).
          { id: "custom", displayName: "Custom", command: "/usr/bin/custom", args: [] },
        ],
      }),
    );

    const config = loadConfig(configPath);
    const claude = config.runtimes.find((r) => r.id === "claude-code");
    expect(claude?.resumeArg).toBe("--resume");
    expect(claude?.sessionIdArg).toBe("--session-id");
    expect(claude?.supportsResume).toBe(true);
    expect(claude?.supportsModelSelection).toBe(true);

    const shell = config.runtimes.find((r) => r.id === "shell");
    expect(shell?.displayName).toBe("Custom Shell");
    expect(shell?.command).toBe("zsh");
    expect(shell?.supportsPrompt).toBe(true); // backfilled

    const custom = config.runtimes.find((r) => r.id === "custom");
    expect(custom?.resumeArg).toBeUndefined();
  });

  it("keeps Codex goals enabled across stale config loads and settings patches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-config-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        runtimes: [{ id: "codex", displayName: "Codex", command: "codex", args: ["--yolo"] }],
      }),
    );

    const config = loadConfig(configPath);
    expect(config.runtimes.find((runtime) => runtime.id === "codex")?.args).toEqual(["--yolo", "--enable", "goals"]);

    const patched = mergeConfigPatch(config, {
      runtimes: [{ id: "codex", displayName: "Codex", command: "codex", args: [] }],
    });
    expect(patched.runtimes.find((runtime) => runtime.id === "codex")?.args).toEqual(["--enable", "goals"]);

    const alreadyEnabled = mergeConfigPatch(config, {
      runtimes: [{ id: "codex", displayName: "Codex", command: "codex", args: ["--enable=goals"] }],
    });
    expect(alreadyEnabled.runtimes.find((runtime) => runtime.id === "codex")?.args).toEqual(["--enable=goals"]);

    const disabledLater = mergeConfigPatch(config, {
      runtimes: [
        {
          id: "codex",
          displayName: "Codex",
          command: "codex",
          args: ["--enable", "goals", "--config", "features.goals=false"],
        },
      ],
    });
    expect(disabledLater.runtimes.find((runtime) => runtime.id === "codex")?.args).toEqual([
      "--enable",
      "goals",
      "--config",
      "features.goals=false",
      "--enable",
      "goals",
    ]);
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

describe("scratchpad.path config field", () => {
  it("accepts an absolute scratchpad.path and round-trips through save/load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scratchpath-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    const notesPath = path.join(dir, "custom-notes.md");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        scratchpad: { path: notesPath },
      }),
    );

    const loaded = loadConfig(configPath);
    expect(loaded.scratchpad.path).toBe(notesPath);

    saveConfig(loaded, configPath);
    const reloaded = loadConfig(configPath);
    expect(reloaded.scratchpad.path).toBe(notesPath);
  });

  it("tilde-expands ~/X to <homedir>/X before storage", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-tilde-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        scratchpad: { path: "~/some-notes-test-file.md" },
      }),
    );

    const loaded = loadConfig(configPath);
    expect(loaded.scratchpad.path).toBe(path.join(os.homedir(), "some-notes-test-file.md"));
    // No literal `~` survives.
    expect(loaded.scratchpad.path?.startsWith("~")).toBe(false);
  });

  it("rejects a relative scratchpad.path with a zod error naming the field and hinting at ~/", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-relreject-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        scratchpad: { path: "relative/notes.md" },
      }),
    );

    let caught: unknown = null;
    try {
      loadConfig(configPath);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
    const message = String((caught as Error).message ?? caught);
    expect(message).toMatch(/absolute/i);
    expect(message).toMatch(/~\//);
    // The zod error path must reference scratchpad.path so future schema renames
    // don't silently break the user-facing wiring.
    expect(message).toMatch(/scratchpad/);
    expect(message).toMatch(/path/);
  });

  it("defaults scratchpad.path to undefined so the effective path falls back to dataDir/scratchpad.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-spdefault-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    const loaded = loadConfig(configPath);
    expect(loaded.scratchpad).toBeDefined();
    expect(loaded.scratchpad.path).toBeUndefined();
    expect(effectiveNotesPath(loaded)).toBe(path.join(loaded.dataDir, "scratchpad.md"));
  });

  it("in worktree mode (CITADEL_WORKTREE=1), strips scratchpad.path from raw config in memory but leaves the file on disk untouched", () => {
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-wt-strip-"));
    dirs.push(root);
    const worktreeDataDir = path.join(root, "wt-data");
    process.env.CITADEL_DATA_DIR = worktreeDataDir;
    process.env.CITADEL_WORKTREE = "1";
    const configPath = path.join(root, "leaked.config.json");
    const leakedNotes = path.join(root, "prod-notes.md");
    const rawContent = JSON.stringify({
      version: 1,
      dataDir: "/home/prod/.local/share/citadel",
      databasePath: "/home/prod/.local/share/citadel/citadel.sqlite",
      scratchpad: { path: leakedNotes },
    });
    fs.writeFileSync(configPath, rawContent);
    try {
      const loaded = loadConfig(configPath);
      expect(loaded.dataDir).toBe(worktreeDataDir);
      expect(loaded.scratchpad.path).toBeUndefined();
      // The strip is in-memory only — the file on disk still contains the
      // leaked value (no surprise file mutations in a loader).
      const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(onDisk.scratchpad?.path).toBe(leakedNotes);
    } finally {
      // biome-ignore lint/performance/noDelete: must actually unset.
      if (prevData === undefined) delete process.env.CITADEL_DATA_DIR;
      else process.env.CITADEL_DATA_DIR = prevData;
      // biome-ignore lint/performance/noDelete: must actually unset.
      if (prevWorktree === undefined) delete process.env.CITADEL_WORKTREE;
      else process.env.CITADEL_WORKTREE = prevWorktree;
    }
  });

  it("in prod mode (no CITADEL_WORKTREE), honors a persisted scratchpad.path", () => {
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-prod-sp-"));
    dirs.push(root);
    // biome-ignore lint/performance/noDelete: must actually clear.
    delete process.env.CITADEL_DATA_DIR;
    // biome-ignore lint/performance/noDelete: must actually clear.
    delete process.env.CITADEL_WORKTREE;
    const customNotes = path.join(root, "my-notes.md");
    const configPath = path.join(root, "prod.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: path.join(root, "data"),
        databasePath: path.join(root, "data", "citadel.sqlite"),
        scratchpad: { path: customNotes },
      }),
    );
    try {
      const loaded = loadConfig(configPath);
      expect(loaded.scratchpad.path).toBe(customNotes);
      expect(effectiveNotesPath(loaded)).toBe(customNotes);
    } finally {
      if (prevData !== undefined) process.env.CITADEL_DATA_DIR = prevData;
      if (prevWorktree !== undefined) process.env.CITADEL_WORKTREE = prevWorktree;
    }
  });

  it("preserves other scratchpad.* fields under worktree strip (only `path` is dropped)", () => {
    // Forward-compat guard: when the schema grows (e.g. scratchpad.history.*),
    // the strip-on-load defense MUST drop only `path` — accidentally flat-stripping
    // the whole `scratchpad` key would silently lose future settings.
    const prevData = process.env.CITADEL_DATA_DIR;
    const prevWorktree = process.env.CITADEL_WORKTREE;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-wt-siblings-"));
    dirs.push(root);
    process.env.CITADEL_DATA_DIR = path.join(root, "wt-data");
    process.env.CITADEL_WORKTREE = "1";
    const configPath = path.join(root, "leaked-with-siblings.config.json");
    // Write a raw object that includes both `path` and an unknown sibling. Zod
    // strips unknown keys today, so the loaded `scratchpad` will be `{}` either
    // way — but the load-time strip must not throw and must not surface `path`.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        scratchpad: { path: "/should/be/stripped.md", futureFlag: true },
      }),
    );
    try {
      const loaded = loadConfig(configPath);
      expect(loaded.scratchpad.path).toBeUndefined();
      // On-disk leaked value untouched (strip is in-memory only).
      const onDisk = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(onDisk.scratchpad).toEqual({ path: "/should/be/stripped.md", futureFlag: true });
    } finally {
      // biome-ignore lint/performance/noDelete: must actually unset.
      if (prevData === undefined) delete process.env.CITADEL_DATA_DIR;
      else process.env.CITADEL_DATA_DIR = prevData;
      // biome-ignore lint/performance/noDelete: must actually unset.
      if (prevWorktree === undefined) delete process.env.CITADEL_WORKTREE;
      else process.env.CITADEL_WORKTREE = prevWorktree;
    }
  });

  it("rejects bare `~` (no slash) as relative — only `~/X` is tilde-expanded", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-bare-tilde-"));
    dirs.push(dir);
    const configPath = path.join(dir, "citadel.config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        dataDir: dir,
        databasePath: path.join(dir, "citadel.sqlite"),
        scratchpad: { path: "~" },
      }),
    );
    expect(() => loadConfig(configPath)).toThrow(/absolute/i);
  });

  it("effectiveNotesPath returns the override when set, else <dataDir>/scratchpad.md", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-effpath-"));
    dirs.push(dir);
    const configWithoutOverride = {
      dataDir: dir,
      scratchpad: { path: undefined as string | undefined },
    };
    expect(effectiveNotesPath(configWithoutOverride)).toBe(path.join(dir, "scratchpad.md"));
    expect(defaultNotesPath(dir)).toBe(path.join(dir, "scratchpad.md"));

    const override = path.join(dir, "elsewhere", "notes.md");
    const configWithOverride = { dataDir: dir, scratchpad: { path: override } };
    expect(effectiveNotesPath(configWithOverride)).toBe(override);
  });
});
