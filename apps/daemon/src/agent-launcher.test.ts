import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  composeAgentLaunchInput,
  resolveCustomAgent,
  resolvePredefinedAgent,
} from "./agent-launcher.js";
import { createAgentDefinitionsStorage } from "./agent-definitions/storage.js";

const dirs: string[] = [];

beforeEach(() => {
  dirs.length = 0;
});

afterEach(() => {
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function makeStorage() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-launcher-"));
  dirs.push(baseDir);
  return createAgentDefinitionsStorage({
    baseDir,
    configPath: path.join(baseDir, "..", `${path.basename(baseDir)}.config.json`),
  });
}

describe("composeAgentLaunchInput", () => {
  it("prepends the system prompt with the ## System / ## User prompt headers", () => {
    const result = composeAgentLaunchInput({
      definition: {
        id: "implementation",
        kind: "predefined",
        name: "Implementation",
        systemPrompt: "Run TDD.",
        runtime: "claude-code",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      userPrompt: "Add the feature.",
    });
    expect(result.prompt).toBe("## System\nRun TDD.\n\n## User prompt\nAdd the feature.");
    expect(result.runtimeId).toBe("claude-code");
  });

  it("uses the definition's runtime when set; falls back to defaultRuntime", () => {
    const def = {
      id: "implementation",
      kind: "predefined" as const,
      name: "Implementation",
      systemPrompt: "x",
      runtime: "codex",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      composeAgentLaunchInput({ definition: def, userPrompt: "go", defaultRuntime: "claude-code" }).runtimeId,
    ).toBe("codex");
    expect(
      composeAgentLaunchInput({ definition: { ...def, runtime: "" }, userPrompt: "go", defaultRuntime: "pi" }).runtimeId,
    ).toBe("pi");
  });

  it("threads optional repo + namespace fields through unchanged", () => {
    const result = composeAgentLaunchInput({
      definition: {
        id: "implementation",
        kind: "predefined",
        name: "Implementation",
        systemPrompt: "x",
        runtime: "claude-code",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      userPrompt: "go",
      repoName: "citadel",
      namespaceId: "ns-1",
      displayName: "Display",
      workspaceName: "ws-name",
      branchName: "fb-branch",
    });
    expect(result.repoName).toBe("citadel");
    expect(result.namespaceId).toBe("ns-1");
    expect(result.displayName).toBe("Display");
    expect(result.branchName).toBe("fb-branch");
  });
});

describe("resolvePredefinedAgent / resolveCustomAgent", () => {
  it("resolves a predefined agent by reserved id", () => {
    const storage = makeStorage();
    const result = resolvePredefinedAgent(storage, "implementation");
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.definition.id).toBe("implementation");
    expect(result.definition.kind).toBe("predefined");
  });

  it("resolveCustomAgent rejects predefined ids with a clear error", () => {
    const storage = makeStorage();
    storage.list(); // seed
    const result = resolveCustomAgent(storage, "implementation");
    expect(result).toEqual({ error: "use_predefined_launcher_for_this_id" });
  });

  it("resolveCustomAgent returns agent_not_found for unknown id", () => {
    const storage = makeStorage();
    storage.list();
    const result = resolveCustomAgent(storage, "nope");
    expect(result).toEqual({ error: "agent_not_found" });
  });

  it("resolveCustomAgent returns the definition for a real custom agent", () => {
    const storage = makeStorage();
    storage.list();
    const custom = storage.create({ name: "Reviewer", systemPrompt: "x", runtime: "claude-code" });
    const result = resolveCustomAgent(storage, custom.id);
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.definition.id).toBe(custom.id);
  });
});
