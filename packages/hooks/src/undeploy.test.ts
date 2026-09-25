import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUndeployHook, runUndeployHook } from "./undeploy.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-undeploy-"));
  tempDirs.push(dir);
  return dir;
}

function writeHook(dir: string, body: string, { executable }: { executable: boolean }) {
  const hookPath = path.join(dir, ".citadel", "hooks", "undeploy");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, body);
  if (executable) fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

describe("resolveUndeployHook", () => {
  it("resolves an executable repo file", () => {
    const dir = tempWorkspace();
    const hookPath = writeHook(dir, "#!/bin/sh\necho ok\n", { executable: true });
    const resolution = resolveUndeployHook({ workspacePath: dir });
    expect(resolution).toEqual({ source: "repo-file", filePath: hookPath, note: null });
  });

  it("returns a note when the file is not executable", () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\necho ok\n", { executable: false });
    const resolution = resolveUndeployHook({ workspacePath: dir });
    expect(resolution.source).toBe("none");
    expect(resolution.note).toMatch(/chmod \+x/);
  });
});

describe("runUndeployHook", () => {
  it("runs the hook and passes the app name as argv[1]", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nprintf 'undeploy:%s\\n' \"${1:-all}\"\n", { executable: true });
    const result = await runUndeployHook({
      resolution: resolveUndeployHook({ workspacePath: dir }),
      env: { workspaceId: "ws", workspacePath: dir, workspaceBranch: "main", repoId: "repo" },
      appName: "web",
    });
    expect(result.exitStatus).toBe(0);
    expect(result.stdoutTail).toContain("undeploy:web");
  });

  it("runs all-app undeploy with no app arg", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\nprintf 'undeploy:%s\\n' \"${1:-all}\"\n", { executable: true });
    const result = await runUndeployHook({
      resolution: resolveUndeployHook({ workspacePath: dir }),
      env: { workspaceId: "ws", workspacePath: dir, workspaceBranch: "main", repoId: "repo" },
    });
    expect(result.exitStatus).toBe(0);
    expect(result.stdoutTail).toContain("undeploy:all");
  });
});
