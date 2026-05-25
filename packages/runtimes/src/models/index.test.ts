import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MODELS_FALLBACK,
  fetchCodexModels,
  fetchCursorAgentModels,
  fetchPiModels,
  hasRuntimeModelLister,
  parseClaudeCodeModelsList,
  runtimeModelListers,
} from "./index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const claudeFixture = fs.readFileSync(path.join(fixturesDir, "claude-code-models.txt"), "utf8");

describe("runtimeModelListers", () => {
  it("exposes listers for the four citadel-maintained runtimes", () => {
    expect(Object.keys(runtimeModelListers).sort()).toEqual(
      ["claude-code", "codex", "cursor-agent", "pi"].sort(),
    );
  });

  it("hasRuntimeModelLister gates by runtime id", () => {
    expect(hasRuntimeModelLister("claude-code")).toBe(true);
    expect(hasRuntimeModelLister("shell")).toBe(false);
    expect(hasRuntimeModelLister("totally-unknown")).toBe(false);
  });

  it("non-claude runtimes return a non-empty default list with no probeError", async () => {
    const codex = await fetchCodexModels({ command: "codex" });
    expect(codex.models.length).toBeGreaterThan(0);
    expect(codex.probeError).toBeUndefined();

    const cursor = await fetchCursorAgentModels({ command: "cursor-agent" });
    expect(cursor.models.length).toBeGreaterThan(0);
    expect(cursor.probeError).toBeUndefined();

    const pi = await fetchPiModels({ command: "pi" });
    expect(pi.models.length).toBeGreaterThan(0);
    expect(pi.probeError).toBeUndefined();
  });
});

describe("parseClaudeCodeModelsList", () => {
  it("extracts model ids from the captured /models picker fixture", () => {
    const ids = parseClaudeCodeModelsList(claudeFixture);
    expect(ids).toEqual([
      "claude-opus-4-7",
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
      "claude-sonnet-4-5",
    ]);
  });

  it("dedupes repeated mentions and preserves first-seen order", () => {
    const text = "claude-sonnet-4-6 ... claude-opus-4-7 ... claude-sonnet-4-6 again";
    expect(parseClaudeCodeModelsList(text)).toEqual(["claude-sonnet-4-6", "claude-opus-4-7"]);
  });

  it("returns an empty list when no model identifiers are present", () => {
    expect(parseClaudeCodeModelsList("nothing to see here")).toEqual([]);
  });

  it("fallback list has the canonical models", () => {
    expect(CLAUDE_CODE_MODELS_FALLBACK.map((entry) => entry.id)).toContain("claude-sonnet-4-6");
    expect(CLAUDE_CODE_MODELS_FALLBACK.map((entry) => entry.id)).toContain("claude-opus-4-7");
  });
});
