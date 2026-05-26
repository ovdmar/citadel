import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TEARDOWN_HOOK_RELATIVE_PATH, resolveTeardownHook, runTeardownHook } from "./teardown.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-teardown-"));
  tempDirs.push(dir);
  return dir;
}

function writeHook(dir: string, body: string, { executable }: { executable: boolean }) {
  const hookPath = path.join(dir, TEARDOWN_HOOK_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, body);
  if (executable) fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

describe("resolveTeardownHook", () => {
  it("returns repo-file when an executable .citadel/hooks/teardown exists", () => {
    const dir = tempWorkspace();
    const hookPath = writeHook(dir, "#!/bin/sh\nexit 0\n", { executable: true });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    expect(resolution.source).toBe("repo-file");
    expect(resolution.filePath).toBe(hookPath);
    expect(resolution.note).toBeNull();
  });

  it("returns none when the file is missing", () => {
    const dir = tempWorkspace();
    const resolution = resolveTeardownHook({ workspacePath: dir });
    expect(resolution.source).toBe("none");
    expect(resolution.filePath).toBeNull();
    expect(resolution.note).toBeNull();
  });

  it("returns none with a diagnostic note when the file exists but is not executable", () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nexit 0\n", { executable: false });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    expect(resolution.source).toBe("none");
    expect(resolution.note).toMatch(/exists but is not executable/);
    expect(resolution.note).toMatch(/chmod \+x/);
  });
});

describe("runTeardownHook (integration)", () => {
  const env = {
    workspaceId: "ws_test",
    workspacePath: "",
    workspaceBranch: "main",
    repoId: "repo_test",
  };

  it("captures exit status 0 and streams stdout line-by-line", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nprintf 'first\\nsecond\\n'\nexit 0\n", { executable: true });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    const lines: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const result = await runTeardownHook({
      resolution,
      env: { ...env, workspacePath: dir },
      onOutput: (line) => lines.push(line),
    });
    expect(result.exitStatus).toBe(0);
    const stdout = lines
      .filter((l) => l.stream === "stdout")
      .map((l) => l.chunk)
      .join("");
    expect(stdout).toContain("first");
    expect(stdout).toContain("second");
  });

  it("surfaces stderrTail on non-zero exit", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nprintf 'boom\\n' >&2\nexit 7\n", { executable: true });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    const result = await runTeardownHook({ resolution, env: { ...env, workspacePath: dir } });
    expect(result.exitStatus).toBe(7);
    expect(result.stderrTail).toContain("boom");
  });

  it("honors timeoutMs and SIGKILLs the child on overrun", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nsleep 5\n", { executable: true });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    const start = Date.now();
    const result = await runTeardownHook({
      resolution,
      env: { ...env, workspacePath: dir },
      timeoutMs: 250,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    // exit code null when killed by signal, or non-zero — both indicate timeout-kill.
    expect(result.exitStatus === null || result.exitStatus !== 0).toBe(true);
  });

  it("does not hang when the hook spawns a detached daemon and exits", async () => {
    const dir = tempWorkspace();
    // Background a sleep; redirect its fds so the child doesn't keep ours open.
    writeHook(dir, "#!/bin/sh\n(sleep 3 >/dev/null 2>&1 </dev/null &)\nprintf 'spawned\\n'\nexit 0\n", {
      executable: true,
    });
    const resolution = resolveTeardownHook({ workspacePath: dir });
    const start = Date.now();
    const result = await runTeardownHook({ resolution, env: { ...env, workspacePath: dir } });
    const elapsed = Date.now() - start;
    expect(result.exitStatus).toBe(0);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("throws when called with source=none", async () => {
    await expect(
      runTeardownHook({
        resolution: { source: "none", filePath: null, note: null },
        env: { ...env, workspacePath: "/" },
      }),
    ).rejects.toThrow(/teardown_hook_not_configured/);
  });
});
