import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIX_CONFLICTS_DEFAULT_PROMPT,
  FIX_CONFLICTS_HOOK_RELATIVE_PATH,
  resolveFixConflictsPrompt,
} from "./fix-conflicts.js";
import { CITADEL_NON_FF_POLICY } from "./non-ff-policy.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): { path: string; envBase: { workspaceId: string; workspaceBranch: string; repoId: string } } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fix-conflicts-test-"));
  fs.mkdirSync(path.join(dir, ".citadel", "hooks"), { recursive: true });
  dirs.push(dir);
  return {
    path: dir,
    envBase: { workspaceId: "ws_test", workspaceBranch: "feature", repoId: "repo_test" },
  };
}

describe("resolveFixConflictsPrompt", () => {
  it("returns the hardcoded default when no hook file exists", async () => {
    const ws = makeWorkspace();
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("default");
    expect(result.prompt).toBe(FIX_CONFLICTS_DEFAULT_PROMPT);
    expect(result.diagnostic).toBeNull();
  });

  it("returns hook stdout (trimmed) when the hook is executable", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    fs.writeFileSync(hookPath, "#!/bin/sh\nprintf 'Custom merge instructions  \\n'\n");
    fs.chmodSync(hookPath, 0o755);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("hook");
    expect(result.prompt).toBe("Custom merge instructions");
    expect(result.diagnostic).toBeNull();
  });

  it("falls back to default + emits diagnostic when the hook exists but is not executable", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    fs.writeFileSync(hookPath, "#!/bin/sh\necho should-not-run\n");
    fs.chmodSync(hookPath, 0o644);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("default");
    expect(result.prompt).toBe(FIX_CONFLICTS_DEFAULT_PROMPT);
    expect(result.diagnostic).toMatch(/exists but is not executable/);
  });

  it("strips ANSI escape sequences from hook output", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    fs.writeFileSync(hookPath, "#!/bin/sh\nprintf '\\033[31mRED\\033[0m text\\n'\n");
    fs.chmodSync(hookPath, 0o755);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("hook");
    expect(result.prompt).toBe("RED text");
  });

  it("falls back to default when the hook exits non-zero", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    fs.writeFileSync(hookPath, "#!/bin/sh\necho 'oh no' >&2\nexit 7\n");
    fs.chmodSync(hookPath, 0o755);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("default");
    expect(result.diagnostic).toMatch(/fix_conflicts_hook_exit_7/);
  });

  it("falls back to default when the hook produces empty output", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    fs.writeFileSync(hookPath, "#!/bin/sh\nprintf ''\n");
    fs.chmodSync(hookPath, 0o755);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("default");
    expect(result.diagnostic).toMatch(/empty output/);
  });

  it("caps hook stdout at 32 KB", async () => {
    const ws = makeWorkspace();
    const hookPath = path.join(ws.path, FIX_CONFLICTS_HOOK_RELATIVE_PATH);
    // Write 40 KB of repeating bytes; we expect the result to be ≤ 32 KB.
    fs.writeFileSync(
      hookPath,
      "#!/bin/sh\nyes \"line\" | head -c 40960\n",
    );
    fs.chmodSync(hookPath, 0o755);
    const result = await resolveFixConflictsPrompt({ workspacePath: ws.path, ...ws.envBase });
    expect(result.source).toBe("hook");
    expect(result.prompt.length).toBeLessThanOrEqual(32 * 1024);
  });

  it("default prompt references the canonical non-FF policy", () => {
    expect(FIX_CONFLICTS_DEFAULT_PROMPT).toContain(CITADEL_NON_FF_POLICY);
    // Defensive: catches accidental policy weakening at the prompt level.
    expect(FIX_CONFLICTS_DEFAULT_PROMPT).toMatch(/merge/);
    expect(FIX_CONFLICTS_DEFAULT_PROMPT).toMatch(/NOT rebase/);
    expect(FIX_CONFLICTS_DEFAULT_PROMPT).toMatch(/force/);
  });
});
