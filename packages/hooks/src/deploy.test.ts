import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDeployListOutput, probeAppStatus, resolveDeployHook, runDeployHookList } from "./deploy.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-deploy-"));
  tempDirs.push(dir);
  return dir;
}

function writeHook(dir: string, body: string, { executable }: { executable: boolean }) {
  const hookPath = path.join(dir, ".citadel", "hooks", "deploy");
  fs.mkdirSync(path.dirname(hookPath), { recursive: true });
  fs.writeFileSync(hookPath, body);
  if (executable) fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

describe("resolveDeployHook", () => {
  it("prefers the repo file when present and executable", () => {
    const dir = tempWorkspace();
    const hookPath = writeHook(dir, "#!/bin/sh\necho '{\"apps\":[]}'\n", { executable: true });
    const resolution = resolveDeployHook({ workspacePath: dir, repoDeployCommand: "echo fallback" });
    expect(resolution.source).toBe("repo-file");
    expect(resolution.filePath).toBe(hookPath);
    expect(resolution.command).toBeNull();
  });

  it("falls back to the repo-config command when the file is not executable", () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\necho '{\"apps\":[]}'\n", { executable: false });
    const resolution = resolveDeployHook({ workspacePath: dir, repoDeployCommand: "echo fallback" });
    expect(resolution.source).toBe("repo-config");
    expect(resolution.command).toBe("echo fallback");
  });

  it("reports none when neither source is available", () => {
    const dir = tempWorkspace();
    const resolution = resolveDeployHook({ workspacePath: dir, repoDeployCommand: null });
    expect(resolution.source).toBe("none");
  });

  it("ignores whitespace-only commands", () => {
    const dir = tempWorkspace();
    const resolution = resolveDeployHook({ workspacePath: dir, repoDeployCommand: "   \n  " });
    expect(resolution.source).toBe("none");
  });
});

describe("parseDeployListOutput", () => {
  it("returns an empty list for blank stdout", () => {
    expect(parseDeployListOutput("   \n  ")).toEqual({ apps: [] });
  });

  it("parses a valid payload", () => {
    const out = parseDeployListOutput('  {"apps":[{"name":"web","url":"http://localhost:3000"}]}  \n');
    expect(out.apps).toEqual([{ name: "web", url: "http://localhost:3000" }]);
  });

  it("rejects malformed JSON", () => {
    expect(() => parseDeployListOutput("{not json")).toThrow(/invalid_json/);
  });

  it("rejects payloads that violate the schema", () => {
    expect(() => parseDeployListOutput('{"apps":[{"name":"","url":"http://x"}]}')).toThrow();
  });
});

describe("runDeployHookList (integration)", () => {
  it("runs a repo-file hook and parses its output", async () => {
    const dir = tempWorkspace();
    writeHook(
      dir,
      '#!/bin/sh\ncase "$1" in list) printf \'%s\\n\' \'{"apps":[{"name":"web","url":"http://127.0.0.1:65535"}]}\' ;; esac\n',
      { executable: true },
    );
    const result = await runDeployHookList({
      resolution: resolveDeployHook({ workspacePath: dir }),
      env: { workspaceId: "ws", workspacePath: dir, workspaceBranch: "main", repoId: "repo" },
      timeoutMs: 5000,
    });
    expect(result.parsed.apps).toEqual([{ name: "web", url: "http://127.0.0.1:65535" }]);
  });

  it("rejects when the hook exits non-zero", async () => {
    const dir = tempWorkspace();
    writeHook(dir, "#!/bin/sh\necho oops 1>&2\nexit 3\n", { executable: true });
    await expect(
      runDeployHookList({
        resolution: resolveDeployHook({ workspacePath: dir }),
        env: { workspaceId: "ws", workspacePath: dir, workspaceBranch: "main", repoId: "repo" },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/deploy_hook_list_exit_3/);
  });
});

describe("probeAppStatus", () => {
  it("returns unknown for an unparseable url", async () => {
    expect(await probeAppStatus("not a url")).toBe("unknown");
  });

  it("returns stopped for a port nothing is listening on", async () => {
    // Port 1 is privileged and reliably refused without root.
    const status = await probeAppStatus("http://127.0.0.1:1", 400);
    expect(status).toBe("stopped");
  });
});
