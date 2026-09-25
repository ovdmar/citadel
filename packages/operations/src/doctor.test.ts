import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type DoctorDeps, runDoctorChecks } from "./doctor.js";

function fakeConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    dataDir: "/tmp/citadel",
    databasePath: "/tmp/citadel/citadel.sqlite",
    bindHost: "127.0.0.1",
    port: 4010,
    mcp: { enabled: true },
    providers: {
      github: { enabled: true, command: "gh" },
      jira: { enabled: true, command: "jtk" },
    },
    agentRuntimes: [{ id: "claude-code", displayName: "Claude Code", command: "claude" }],
    terminal: { displayName: "Terminal", command: "bash" },
    usageProviders: [],
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [], appHookIds: [], actionHookIds: [] },
    commandPolicy: { hookTimeoutMs: 120000, allowDestructiveWorkspaceCleanup: false },
    ...overrides,
  };
}

function depsWithDefaults(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    which: async () => "/usr/bin/fake",
    fetchHealth: async () => ({ ok: true }),
    readDbSchemaVersion: async () => 1,
    expectedSchemaVersion: 1,
    listRepos: () => [],
    inspectDeployHook: () => "missing",
    listSystemdServices: async () => ({ available: false, citadel: "skipped" }),
    collectProviderHealth: async () => [
      { provider: "github", status: "healthy", refreshedAt: new Date().toISOString(), refreshAge: 0 },
      { provider: "jira", status: "healthy", refreshedAt: new Date().toISOString(), refreshAge: 0 },
    ],
    fsStat: () => ({ exists: true, size: 100 }),
    retries: 1,
    retryDelayMs: 0,
    ...overrides,
  };
}

describe("runDoctorChecks — required binaries", () => {
  it("marks every required binary present as ok", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({ which: async (bin) => `/usr/bin/${bin}` }),
    });
    const binaryChecks = report.checks.filter((c) => c.kind === "binary");
    expect(binaryChecks.length).toBeGreaterThan(0);
    expect(binaryChecks.find((c) => c.id === "binary.tmux")?.status).toBe("ok");
  });

  it("fails when a required binary is missing", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        which: async (bin) => (bin === "tmux" ? null : `/usr/bin/${bin}`),
      }),
    });
    const tmux = report.checks.find((c) => c.id === "binary.tmux");
    expect(tmux?.status).toBe("fail");
    expect(report.summary).toBe("failing");
  });

  it("warns when a recommended binary is missing (gh / jtk)", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        which: async (bin) => (bin === "gh" || bin === "jtk" ? null : `/usr/bin/${bin}`),
      }),
    });
    const gh = report.checks.find((c) => c.id === "binary.gh");
    expect(gh?.status).toBe("warn");
    // Should NOT alone push summary to failing.
    expect(report.summary === "degraded" || report.summary === "ok").toBe(true);
  });

  it("daemon mode skips required-binary checks (the daemon's host has them by definition)", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "daemon",
      deps: depsWithDefaults({ which: async () => null }),
    });
    const binaryChecks = report.checks.filter((c) => c.kind === "binary");
    expect(binaryChecks.every((c) => c.status === "skipped" || c.id === "binary.note")).toBe(true);
  });
});

describe("runDoctorChecks — daemon reachability", () => {
  it("retries before declaring fail", async () => {
    let attempt = 0;
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        retries: 5,
        retryDelayMs: 0,
        fetchHealth: async () => {
          attempt++;
          if (attempt < 3) throw new Error("connection refused");
          return { ok: true };
        },
      }),
    });
    const daemon = report.checks.find((c) => c.id === "daemon.health");
    expect(daemon?.status).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("fails only after exhausting all retries", async () => {
    let attempt = 0;
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        retries: 3,
        retryDelayMs: 0,
        fetchHealth: async () => {
          attempt++;
          throw new Error("connection refused");
        },
      }),
    });
    const daemon = report.checks.find((c) => c.id === "daemon.health");
    expect(daemon?.status).toBe("fail");
    expect(attempt).toBe(3);
  });
});

describe("runDoctorChecks — systemd services", () => {
  it("checks citadel.service without requiring a separate citadel-tmux.service", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        listSystemdServices: async () => ({ available: true, citadel: "ok" }),
      }),
    });
    expect(report.checks.find((c) => c.id === "service.citadel")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "service.citadel-tmux")).toBeUndefined();
  });
});

describe("runDoctorChecks — provider warn-vs-fail contract", () => {
  it("unconfigured provider (binary missing) → warn with hint", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        which: async (bin) => (bin === "gh" ? null : `/usr/bin/${bin}`),
        collectProviderHealth: async () => [
          { provider: "github", status: "unavailable", refreshedAt: new Date().toISOString(), refreshAge: 0 },
        ],
      }),
    });
    const gh = report.checks.find((c) => c.id === "provider.github");
    expect(gh?.status).toBe("warn");
    expect(gh?.hint).toMatch(/unconfigured/i);
  });

  it("configured but unreachable provider → fail", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({
        which: async () => "/usr/bin/fake", // every binary present
        collectProviderHealth: async () => [
          { provider: "github", status: "unavailable", refreshedAt: new Date().toISOString(), refreshAge: 0 },
        ],
      }),
    });
    const gh = report.checks.find((c) => c.id === "provider.github");
    expect(gh?.status).toBe("fail");
  });

  it("healthy provider → ok", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const gh = report.checks.find((c) => c.id === "provider.github");
    expect(gh?.status).toBe("ok");
  });

  it("maps daemon provider IDs onto config provider IDs", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "daemon",
      deps: depsWithDefaults({
        collectProviderHealth: async () => [
          { provider: "github-gh", status: "healthy" },
          { provider: "jira-jtk", status: "healthy" },
        ],
      }),
    });
    expect(report.checks.find((c) => c.id === "provider.github")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "provider.jira")?.status).toBe("ok");
  });

  it("does not treat skipped daemon binary checks as missing provider commands", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "daemon",
      deps: depsWithDefaults({
        which: async () => null,
        collectProviderHealth: async () => [
          { provider: "github-gh", status: "healthy" },
          { provider: "jira-jtk", status: "healthy" },
        ],
      }),
    });
    expect(report.checks.find((c) => c.id === "provider.github")?.status).toBe("ok");
    expect(report.checks.find((c) => c.id === "provider.jira")?.status).toBe("ok");
  });

  it("disabled provider → warn (unconfigured)", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({
        providers: {
          github: { enabled: false, command: "gh" },
          jira: { enabled: true, command: "jtk" },
        },
      }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const gh = report.checks.find((c) => c.id === "provider.github");
    expect(gh?.status).toBe("warn");
    expect(gh?.hint).toMatch(/unconfigured|disabled/i);
  });
});

describe("runDoctorChecks — per-repo hooks", () => {
  it("warns when a repo has no hooks bound and no deploy hook file", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-hooks-"));
    try {
      const repo = {
        id: "r1",
        name: "demo",
        rootPath: tmp,
        defaultBranch: "main",
        defaultRemote: "origin",
        worktreeParent: tmp,
        setupHookIds: [],
        teardownHookIds: [],
        deployHookCommand: null,
        providerIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archivedAt: null,
      };
      const report = await runDoctorChecks({
        config: fakeConfig(),
        mode: "cli",
        deps: depsWithDefaults({ listRepos: () => [repo], inspectDeployHook: () => "missing" }),
      });
      const repoCheck = report.checks.find((c) => c.id === `repo-hooks.${repo.id}`);
      expect(repoCheck?.status).toBe("warn");
      expect(repoCheck?.hint).toMatch(/scaffold with ai/i);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("ok when a repo has at least one bound hook", async () => {
    const repo = {
      id: "r2",
      name: "demo",
      rootPath: "/tmp/r2",
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: "/tmp/r2",
      setupHookIds: ["my-setup"],
      teardownHookIds: [],
      deployHookCommand: null,
      providerIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    };
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({ listRepos: () => [repo], inspectDeployHook: () => "missing" }),
    });
    const repoCheck = report.checks.find((c) => c.id === `repo-hooks.${repo.id}`);
    expect(repoCheck?.status).toBe("ok");
  });

  it("ok when a repo has an executable .citadel/hooks/deploy file", async () => {
    const repo = {
      id: "r3",
      name: "demo",
      rootPath: "/tmp/r3",
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: "/tmp/r3",
      setupHookIds: [],
      teardownHookIds: [],
      deployHookCommand: null,
      providerIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    };
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({ listRepos: () => [repo], inspectDeployHook: () => "executable" }),
    });
    const repoCheck = report.checks.find((c) => c.id === `repo-hooks.${repo.id}`);
    expect(repoCheck?.status).toBe("ok");
  });
});

describe("runDoctorChecks — bind-host-tls inverse warning", () => {
  it("warns when bindHost is non-loopback and tls is absent", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({ bindHost: "0.0.0.0" }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const tlsCheck = report.checks.find((c) => c.id === "config.bind-host-tls");
    expect(tlsCheck?.status).toBe("warn");
  });

  it("does NOT warn when bindHost is 127.0.0.1 and tls is absent (loopback is fine without TLS)", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({ bindHost: "127.0.0.1" }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const tlsCheck = report.checks.find((c) => c.id === "config.bind-host-tls");
    expect(tlsCheck?.status).toBe("ok");
  });

  it("does NOT warn when bindHost is loopback and tls IS configured (the normal mkcert pattern)", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({
        bindHost: "127.0.0.1",
        tls: { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" },
      }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const tlsCheck = report.checks.find((c) => c.id === "config.bind-host-tls");
    expect(tlsCheck?.status).toBe("ok");
  });

  it("does NOT warn when bindHost is non-loopback AND tls IS configured", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({
        bindHost: "0.0.0.0",
        tls: { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" },
      }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    const tlsCheck = report.checks.find((c) => c.id === "config.bind-host-tls");
    expect(tlsCheck?.status).toBe("ok");
  });
});

describe("runDoctorChecks — agent runtimes and terminal", () => {
  it("warns for a missing agent runtime command while another runtime is executable", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({
        agentRuntimes: [
          { id: "claude-code", displayName: "Claude Code", command: "missing-claude" },
          { id: "codex", displayName: "Codex", command: "codex" },
        ],
      }),
      mode: "cli",
      deps: depsWithDefaults({ which: async (bin) => (bin === "missing-claude" ? null : `/usr/bin/${bin}`) }),
    });
    expect(report.checks.find((c) => c.id === "agent-runtime.claude-code")?.status).toBe("warn");
    expect(report.checks.find((c) => c.id === "agent-runtime.available")?.status).toBe("ok");
  });

  it("fails when no configured agent runtime command is executable", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({
        agentRuntimes: [{ id: "claude-code", displayName: "Claude Code", command: "missing-claude" }],
      }),
      mode: "cli",
      deps: depsWithDefaults({ which: async (bin) => (bin === "missing-claude" ? null : `/usr/bin/${bin}`) }),
    });
    expect(report.checks.find((c) => c.id === "agent-runtime.available")?.status).toBe("fail");
    expect(report.summary).toBe("failing");
  });

  it("fails when the terminal command is missing", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({ terminal: { displayName: "Terminal", command: "missing-shell" } }),
      mode: "cli",
      deps: depsWithDefaults({ which: async (bin) => (bin === "missing-shell" ? null : `/usr/bin/${bin}`) }),
    });
    expect(report.checks.find((c) => c.id === "terminal.command")?.status).toBe("fail");
  });
});

describe("runDoctorChecks — DoctorReport shape", () => {
  it("version is always 1", async () => {
    const report = await runDoctorChecks({ config: fakeConfig(), mode: "cli", deps: depsWithDefaults() });
    expect(report.version).toBe(1);
  });

  it("populates protocol from config.tls presence", async () => {
    const http = await runDoctorChecks({ config: fakeConfig(), mode: "cli", deps: depsWithDefaults() });
    expect(http.protocol).toBe("http");

    const https = await runDoctorChecks({
      config: fakeConfig({ tls: { certPath: "/tmp/cert.pem", keyPath: "/tmp/key.pem" } }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    expect(https.protocol).toBe("https");
  });

  it("populates bindUrl with the right scheme + host + port", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig({ bindHost: "127.0.0.1", port: 4337 }),
      mode: "cli",
      deps: depsWithDefaults(),
    });
    expect(report.bindUrl).toBe("http://127.0.0.1:4337");
  });

  it("JSON-roundtrips without loss", async () => {
    const report = await runDoctorChecks({ config: fakeConfig(), mode: "cli", deps: depsWithDefaults() });
    const restored = JSON.parse(JSON.stringify(report));
    expect(restored).toEqual(report);
  });
});

describe("runDoctorChecks — database schema version", () => {
  it("ok when schema version matches expected", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({ readDbSchemaVersion: async () => 1, expectedSchemaVersion: 1 }),
    });
    const db = report.checks.find((c) => c.id === "database.schema");
    expect(db?.status).toBe("ok");
  });

  it("fail when schema version is behind", async () => {
    const report = await runDoctorChecks({
      config: fakeConfig(),
      mode: "cli",
      deps: depsWithDefaults({ readDbSchemaVersion: async () => 0, expectedSchemaVersion: 2 }),
    });
    const db = report.checks.find((c) => c.id === "database.schema");
    expect(db?.status).toBe("fail");
  });
});
