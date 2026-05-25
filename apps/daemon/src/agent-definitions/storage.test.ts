import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentDefinitionsError,
  createAgentDefinitionsStorage,
} from "./storage.js";
import { predefinedAgentIds, predefinedAgentSeed } from "./seed.js";

const dirs: string[] = [];

function makeStorage() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-agents-"));
  const configPath = path.join(baseDir, "..", `${path.basename(baseDir)}.config.json`);
  dirs.push(baseDir);
  return {
    baseDir,
    configPath,
    storage: createAgentDefinitionsStorage({ baseDir, configPath }),
  };
}

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

describe("agent definitions storage", () => {
  it("seeds four predefined definitions on first read", () => {
    const { storage } = makeStorage();
    const list = storage.list();
    expect(list.map((d) => d.id).sort()).toEqual(predefinedAgentIds().sort());
    for (const def of list) {
      expect(def.kind).toBe("predefined");
      expect(def.systemPrompt.length).toBeGreaterThan(0);
      expect(def.runtime).toBe("claude-code");
    }
  });

  it("seed() is idempotent — does not rewrite well-formed files on repeat list()", () => {
    const { storage, baseDir } = makeStorage();
    storage.list();
    const filePath = path.join(baseDir, "implementation.json");
    const beforeMtime = fs.statSync(filePath).mtimeMs;
    // Sleep a tick to let mtime advance if a rewrite happened.
    const wait = Date.now() + 30;
    while (Date.now() < wait) {
      /* spin */
    }
    storage.list();
    const afterMtime = fs.statSync(filePath).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it("recreates a manually-deleted predefined file on next list()", () => {
    const { storage, baseDir } = makeStorage();
    storage.list();
    fs.unlinkSync(path.join(baseDir, "implementation.json"));
    const list2 = storage.list();
    expect(list2.find((d) => d.id === "implementation")).toBeTruthy();
  });

  it("rejects predefined ids for delete and reject custom ids for reset", () => {
    const { storage } = makeStorage();
    storage.list(); // seed
    expect(() => storage.remove("implementation")).toThrowError(AgentDefinitionsError);
    try {
      storage.remove("implementation");
    } catch (err) {
      expect((err as AgentDefinitionsError).code).toBe("predefined_agent_cannot_be_deleted");
    }
    const custom = storage.create({ name: "Custom A", systemPrompt: "hi", runtime: "claude-code" });
    try {
      storage.resetToDefaults(custom.id);
    } catch (err) {
      expect((err as AgentDefinitionsError).code).toBe("predefined_agent_cannot_be_reset_by_custom_id");
    }
  });

  it("create rejects on name collision and update rejects on rename collision", () => {
    const { storage } = makeStorage();
    storage.list();
    storage.create({ name: "Reviewer", systemPrompt: "x", runtime: "claude-code" });
    try {
      storage.create({ name: "reviewer", systemPrompt: "x", runtime: "claude-code" });
    } catch (err) {
      expect((err as AgentDefinitionsError).code).toBe("name_collides");
    }
    const second = storage.create({ name: "Other", systemPrompt: "x", runtime: "claude-code" });
    try {
      storage.update(second.id, { name: "Reviewer" });
    } catch (err) {
      expect((err as AgentDefinitionsError).code).toBe("name_collides");
    }
  });

  it("resetToDefaults restores the citadel-authored seed verbatim, NOT user defaultRuntime", () => {
    const { storage } = makeStorage();
    storage.list();
    storage.writeConfig({ defaultRuntime: "codex" });
    storage.update("implementation", { runtime: "codex", systemPrompt: "rewritten" });
    const reset = storage.resetToDefaults("implementation");
    expect(reset.runtime).toBe("claude-code");
    expect(reset.systemPrompt).toBe(predefinedAgentSeed("implementation").systemPrompt);
  });

  it("custom agent CRUD round-trip", () => {
    const { storage } = makeStorage();
    storage.list();
    const created = storage.create({
      name: "Reviewer",
      systemPrompt: "Review carefully.",
      runtime: "claude-code",
    });
    expect(created.kind).toBe("custom");
    expect(storage.get(created.id)?.systemPrompt).toBe("Review carefully.");
    const updated = storage.update(created.id, { systemPrompt: "Review skeptically." });
    expect(updated.systemPrompt).toBe("Review skeptically.");
    storage.remove(created.id);
    expect(storage.get(created.id)).toBeUndefined();
  });

  it("readConfig defaults when no config file exists; writeConfig persists", () => {
    const { storage } = makeStorage();
    expect(storage.readConfig().defaultRuntime).toBe("claude-code");
    const updated = storage.writeConfig({ defaultRuntime: "codex" });
    expect(updated.defaultRuntime).toBe("codex");
    expect(storage.readConfig().defaultRuntime).toBe("codex");
  });

  it("boot-safety: when baseDir cannot be created, list() returns empty and state() reports unavailable", () => {
    // Point baseDir at a path WHERE a parent is a file — mkdirSync will fail.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-agents-broken-"));
    dirs.push(parent);
    const blockerFile = path.join(parent, "block");
    fs.writeFileSync(blockerFile, "");
    const baseDir = path.join(blockerFile, "agents");
    const configPath = path.join(blockerFile, "agents.config.json");
    const storage = createAgentDefinitionsStorage({ baseDir, configPath });
    expect(storage.list()).toEqual([]);
    expect(storage.state()).toBe("unavailable");
    expect(() => storage.create({ name: "X", systemPrompt: "y", runtime: "claude-code" })).toThrowError(
      AgentDefinitionsError,
    );
  });
});
