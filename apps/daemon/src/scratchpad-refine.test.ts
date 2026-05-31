import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CitadelConfig } from "@citadel/config";
import { loadConfig } from "@citadel/config";
import type { LaunchAgentInput, ProviderHealth, Repo } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCitadelActions, updateCitadelAction } from "./citadel-actions.js";

const runtimeHealthOverrides = vi.hoisted(
  () =>
    new Map<
      string,
      {
        health: "healthy" | "degraded" | "unavailable" | "unknown";
        healthReason: string | null;
      }
    >(),
);

// Stub `listRuntimeHealth` so the tests don't shell out to `bash -lc command -v …`
// for every case (each call costs ~300ms loading the user's login profile,
// which CPU-starves the rest of the suite and times out parallel tests like
// scheduled-agent-routes). The fake mirrors the production shape but reports
// runtimes as healthy iff they are present in the config — the refine module's
// own "runtime in config" check still runs. Individual tests can override a
// runtime's health to exercise fallback behavior without invoking real CLIs.
vi.mock("@citadel/runtimes", async () => {
  const actual = await vi.importActual<typeof import("@citadel/runtimes")>("@citadel/runtimes");
  return {
    ...actual,
    listRuntimeHealth: (
      configured: ReadonlyArray<{ id: string; displayName: string; command: string; args: string[] }>,
    ) =>
      configured.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        command: r.command,
        args: r.args,
        health: runtimeHealthOverrides.get(r.id)?.health ?? ("healthy" as const),
        healthReason: runtimeHealthOverrides.get(r.id)?.healthReason ?? null,
        capabilities: {} as Record<string, never>,
      })),
  };
});

const { refineScratchpad } = await import("./scratchpad-refine.js");

// Fake OperationService — only `launchAgent` and `removeWorkspace` are touched
// by refineScratchpad, so we stub the rest to fail loudly if hit.
type FakeOps = Pick<OperationService, "launchAgent" | "removeWorkspace">;

const dirs: string[] = [];

afterEach(() => {
  runtimeHealthOverrides.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function makeRepoOnDisk(dir: string): string {
  const repoPath = path.join(dir, `repo-${Date.now().toString(36)}`);
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  return repoPath;
}

type RuntimeFixture = CitadelConfig["agentRuntimes"][number];

const claudeRuntime: RuntimeFixture = { id: "claude-code", displayName: "Claude Code", command: "claude", args: [] };
const codexRuntime: RuntimeFixture = { id: "codex", displayName: "Codex", command: "codex", args: ["--yolo"] };
const bashRuntime: RuntimeFixture = { id: "bash-agent", displayName: "Bash Agent", command: "bash", args: ["-l"] };

function makeFixture(opts?: { withClaudeRuntime?: boolean; withRepo?: boolean; agentRuntimes?: RuntimeFixture[] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-refine-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ databasePath: path.join(dir, "citadel.sqlite"), dataDir: dir, mcp: { enabled: true } }),
  );
  const config = loadConfig(configPath) as CitadelConfig;
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  // Only seed agent runtimes when the caller wants them (so we can exercise the
  // runtime_unavailable branches without depending on local binaries).
  config.agentRuntimes = opts?.agentRuntimes ?? (opts?.withClaudeRuntime ? [claudeRuntime] : []);
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  let repoId: string | undefined;
  if (opts?.withRepo) {
    const rootPath = makeRepoOnDisk(dir);
    const now = new Date().toISOString();
    const repo: Repo = {
      id: `repo_${Date.now().toString(36)}`,
      name: path.basename(rootPath),
      rootPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    store.insertRepo(repo);
    repoId = repo.id;
  }
  return { dir, config, store, repoId };
}

const noopHealth = async (): Promise<ProviderHealth[]> => [];

describe("refineScratchpad — degradation matrix", () => {
  it("returns runtime_unavailable when no agent runtime is configured", async () => {
    const { config, store } = makeFixture({ withClaudeRuntime: false, withRepo: true });
    const operations: FakeOps = {
      launchAgent: vi.fn(),
      removeWorkspace: vi.fn(),
    } as unknown as FakeOps;
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { prompt: "do a refine pass mentioning in-progress" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("runtime_unavailable");
      expect(result.detail).toContain("claude-code");
    }
    expect(operations.launchAgent).not.toHaveBeenCalled();
  });

  it("returns repo_required when no repo is registered and no repoId given", async () => {
    const { config, store } = makeFixture({ withClaudeRuntime: true, withRepo: false });
    const operations: FakeOps = {
      launchAgent: vi.fn(),
      removeWorkspace: vi.fn(),
    } as unknown as FakeOps;
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { prompt: "refine — skip in-progress" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("repo_required");
  });

  it("emits a warning when the prompt omits the in-progress safeguard", async () => {
    const { config, store, repoId } = makeFixture({ withClaudeRuntime: true, withRepo: true });
    const launchAgent = vi.fn(async (input: LaunchAgentInput) => ({
      workspaceId: "ws-1",
      sessionId: "session-1",
      operationId: "op-1",
      workspace: { id: "ws-1", name: input.workspaceName ?? "x" },
    }));
    const operations: FakeOps = {
      launchAgent,
      removeWorkspace: vi.fn(),
    } as unknown as FakeOps;
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "tidy the scratchpad. no safeguard." },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toBeDefined();
      expect(result.warning?.toLowerCase()).toContain("in-progress");
      expect(result.workspaceId).toBe("ws-1");
    }
    expect(launchAgent).toHaveBeenCalledTimes(1);
    const launchInput = launchAgent.mock.calls[0]?.[0] as LaunchAgentInput;
    expect(launchInput.runtimeId).toBe("claude-code");
    expect(launchInput.workspaceName).toMatch(/^refine-scratchpad-/);
  });

  it("falls back to the next configured agent runtime when the preferred action runtime is unavailable", async () => {
    runtimeHealthOverrides.set("claude-code", {
      health: "unavailable",
      healthReason: "Claude subscription access is disabled",
    });
    const { config, store, repoId } = makeFixture({ agentRuntimes: [claudeRuntime, codexRuntime], withRepo: true });
    const launchAgent = vi.fn(async (_input: LaunchAgentInput, _runtime: { displayName: string }) => ({
      workspaceId: "ws-codex",
      sessionId: "session-codex",
      operationId: "op-codex",
      workspace: { id: "ws-codex", name: "x" },
    }));
    const operations: FakeOps = { launchAgent, removeWorkspace: vi.fn() } as unknown as FakeOps;

    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "refine — skip blocks tagged in-progress" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toContain("Launched 'codex' instead");
    const launchInput = launchAgent.mock.calls[0]?.[0] as LaunchAgentInput;
    const runtime = launchAgent.mock.calls[0]?.[1] as { displayName: string };
    expect(launchInput.runtimeId).toBe("codex");
    expect(runtime.displayName).toBe("Codex");
  });

  it("honors the saved action runtime preference when it is available", async () => {
    const { config, store, repoId } = makeFixture({ agentRuntimes: [claudeRuntime, codexRuntime], withRepo: true });
    const [action] = await listCitadelActions(config.dataDir);
    if (!action) throw new Error("expected seeded action");
    await updateCitadelAction(config.dataDir, action.id, { runtimeId: "codex", updatedAt: action.updatedAt });
    const launchAgent = vi.fn(async (_input: LaunchAgentInput) => ({
      workspaceId: "ws-codex",
      sessionId: "session-codex",
      operationId: "op-codex",
      workspace: { id: "ws-codex", name: "x" },
    }));
    const operations: FakeOps = { launchAgent, removeWorkspace: vi.fn() } as unknown as FakeOps;

    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "refine — skip blocks tagged in-progress" },
    );

    expect(result.ok).toBe(true);
    const launchInput = launchAgent.mock.calls[0]?.[0] as LaunchAgentInput;
    expect(launchInput.runtimeId).toBe("codex");
  });

  it("does not fall back to a plain shell command", async () => {
    runtimeHealthOverrides.set("claude-code", {
      health: "unavailable",
      healthReason: "Claude subscription access is disabled",
    });
    const { config, store, repoId } = makeFixture({ agentRuntimes: [claudeRuntime, bashRuntime], withRepo: true });
    const operations: FakeOps = { launchAgent: vi.fn(), removeWorkspace: vi.fn() } as unknown as FakeOps;

    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "refine — skip blocks tagged in-progress" },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("runtime_unavailable");
      expect(result.detail).toContain("No other configured agent runtime is available");
    }
    expect(operations.launchAgent).not.toHaveBeenCalled();
  });

  it("succeeds with no warning when the prompt mentions in-progress", async () => {
    const { config, store, repoId } = makeFixture({ withClaudeRuntime: true, withRepo: true });
    const launchAgent = vi.fn(async () => ({
      workspaceId: "ws-2",
      sessionId: "session-2",
      operationId: "op-2",
      workspace: { id: "ws-2", name: "x" },
    }));
    const operations: FakeOps = { launchAgent, removeWorkspace: vi.fn() } as unknown as FakeOps;
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "refine — skip blocks tagged in-progress" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning).toBeUndefined();
  });

  it("surfaces an unhealthy provider as a warning (not a block)", async () => {
    const { config, store, repoId } = makeFixture({ withClaudeRuntime: true, withRepo: true });
    const launchAgent = vi.fn(async () => ({
      workspaceId: "ws-3",
      sessionId: "session-3",
      operationId: "op-3",
      workspace: { id: "ws-3", name: "x" },
    }));
    const operations: FakeOps = { launchAgent, removeWorkspace: vi.fn() } as unknown as FakeOps;
    const unhealthy = async (): Promise<ProviderHealth[]> => [
      {
        id: "github",
        kind: "ci",
        displayName: "GitHub Actions",
        status: "unavailable",
        reason: "rate_limited",
        checkedAt: new Date().toISOString(),
      },
    ];
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: unhealthy },
      { ...(repoId ? { repoId } : {}), prompt: "tidy. skip in-progress." },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The in-progress safeguard is present so the warning falls through to
      // the provider-unavailable case.
      expect(result.warning).toContain("GitHub Actions");
    }
  });

  it("returns launch_failed and attempts orphan cleanup when launchAgent throws", async () => {
    const { config, store, repoId } = makeFixture({ withClaudeRuntime: true, withRepo: true });
    const launchAgent = vi.fn(async () => {
      throw new Error("agent_start_failed");
    });
    const removeWorkspace = vi.fn(async () => ({ workspaceId: "any", removed: true }));
    const operations: FakeOps = { launchAgent, removeWorkspace } as unknown as FakeOps;
    const result = await refineScratchpad(
      { config, store, operations: operations as unknown as OperationService, providerHealth: noopHealth },
      { ...(repoId ? { repoId } : {}), prompt: "tidy. skip in-progress." },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("launch_failed");
      expect(result.detail).toBe("agent_start_failed");
      // No orphan workspace was created by our throwing fake, so cleanup
      // should not be called (the refine module only attempts cleanup when it
      // finds a workspace with the deterministic name in store.listWorkspaces).
      expect(removeWorkspace).not.toHaveBeenCalled();
    }
  });
});
