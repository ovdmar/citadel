import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFileHooks } from "./discovery.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-discovery-"));
  dirs.push(dir);
  return dir;
}

function writeHook(workspacePath: string, event: string, name: string, body: string, executable = true): string {
  const eventDir = path.join(workspacePath, ".citadel", "hooks", event);
  fs.mkdirSync(eventDir, { recursive: true });
  const file = path.join(eventDir, name);
  fs.writeFileSync(file, body);
  if (executable) fs.chmodSync(file, 0o755);
  return file;
}

describe("discoverFileHooks", () => {
  it("returns empty hooks and diagnostics when the event folder is missing", () => {
    const ws = makeWorkspace();
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("classifies .sh as command-file and .agent as agent-file", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "10-bootstrap.sh", "#!/bin/sh\necho ok\n");
    writeHook(ws, "workspace.setup", "20-notify.agent", "Notify the team.\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toHaveLength(2);
    expect(result.hooks[0]?.kind).toBe("command-file");
    expect(result.hooks[0]?.id).toBe("file:workspace.setup/10-bootstrap.sh");
    expect(result.hooks[1]?.kind).toBe("agent-file");
    expect(result.hooks[1]?.id).toBe("file:workspace.setup/20-notify.agent");
  });

  it("ignores files with unknown extensions and ignores subdirectories", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "ok.sh", "#!/bin/sh\n");
    writeHook(ws, "workspace.setup", "README.md", "# notes\n", false);
    fs.mkdirSync(path.join(ws, ".citadel", "hooks", "workspace.setup", "subdir"), { recursive: true });
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.id).toBe("file:workspace.setup/ok.sh");
    expect(result.diagnostics).toEqual([]);
  });

  it("returns hooks sorted lexicographically by filename", () => {
    const ws = makeWorkspace();
    // Write in reverse order to prove sort actually happens.
    writeHook(ws, "workspace.setup", "30-c.sh", "#!/bin/sh\n");
    writeHook(ws, "workspace.setup", "10-a.sh", "#!/bin/sh\n");
    writeHook(ws, "workspace.setup", "20-b.sh", "#!/bin/sh\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks.map((h) => h.id)).toEqual([
      "file:workspace.setup/10-a.sh",
      "file:workspace.setup/20-b.sh",
      "file:workspace.setup/30-c.sh",
    ]);
  });

  it("excludes a .sh file that lacks the executable bit and records a diagnostic", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "broken.sh", "#!/bin/sh\n", /* executable */ false);
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.id).toBe("file:workspace.setup/broken.sh");
    expect(result.diagnostics[0]?.error).toMatch(/not executable/);
  });

  it("treats a .agent file with no frontmatter as a body-only prompt", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "plain.agent", "just a prompt body\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toHaveLength(1);
    const hook = result.hooks[0];
    expect(hook?.kind).toBe("agent-file");
    if (hook?.kind === "agent-file") {
      expect(hook.body).toBe("just a prompt body\n");
      expect(hook.meta).toEqual({});
    }
  });

  it("rejects a .agent file with malformed frontmatter and records a diagnostic", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "bad.agent", "---\nno colon here\n---\nbody\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics[0]?.error).toMatch(/malformed frontmatter/);
  });

  it("rejects a .agent file with a reserved key (target)", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "reserved.agent", "---\ntarget: fresh\n---\nbody\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics[0]?.error).toMatch(/frontmatter|target/i);
  });

  it("rejects a .agent file with an unknown frontmatter key (strict zod)", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "unknown.agent", "---\nfoo: bar\n---\nbody\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics[0]?.error).toMatch(/frontmatter|foo/i);
  });

  it("rejects a .agent file with empty body after frontmatter", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "empty.agent", "---\nruntime: claude-code\n---\n   \n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics[0]?.error).toMatch(/empty/i);
  });

  it("rejects a .agent file with invalid displayName charset", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "bad-name.agent", "---\ndisplayName: no/slashes\n---\nbody\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics[0]?.error).toMatch(/displayName/i);
  });

  it("rejects .agent under agent.started/ (prevents infinite session-spawn loop) but accepts .sh", () => {
    const ws = makeWorkspace();
    writeHook(ws, "agent.started", "loop.agent", "would loop\n");
    writeHook(ws, "agent.started", "safe.sh", "#!/bin/sh\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "agent.started" });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.id).toBe("file:agent.started/safe.sh");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.id).toBe("file:agent.started/loop.agent");
    expect(result.diagnostics[0]?.error).toMatch(/agent\.started|loop/i);
  });

  it("works for every HookEvent (parameterized smoke test — no per-event special-casing)", () => {
    const events = [
      "workspace.setup",
      "workspace.teardown",
      "workspace.apps",
      "workspace.action",
      "workspace.created",
      "workspace.archived",
      "workspace.removed",
      "pr.merge",
      "merge.conflict.detected",
      "review.requested",
    ] as const;
    for (const event of events) {
      const ws = makeWorkspace();
      writeHook(ws, event, "hook.agent", `prompt for ${event}\n`);
      const result = discoverFileHooks({ workspacePath: ws, event });
      expect(result.hooks).toHaveLength(1);
      expect(result.hooks[0]?.kind).toBe("agent-file");
    }
  });

  it("follows symlinks for .sh hooks (matches the deploy-hook X_OK pattern; plan failure-modes §1)", () => {
    const ws = makeWorkspace();
    // Real executable file lives outside the event dir; symlink it in.
    const realFile = path.join(ws, "real-bootstrap.sh");
    fs.writeFileSync(realFile, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(realFile, 0o755);
    const eventDir = path.join(ws, ".citadel", "hooks", "workspace.setup");
    fs.mkdirSync(eventDir, { recursive: true });
    fs.symlinkSync(realFile, path.join(eventDir, "bootstrap.sh"));
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.kind).toBe("command-file");
    expect(result.diagnostics).toEqual([]);
  });

  it("includes both foo.sh and foo.agent when they share a base name; lex order puts .agent before .sh", () => {
    const ws = makeWorkspace();
    writeHook(ws, "workspace.setup", "foo.sh", "#!/bin/sh\nexit 0\n");
    writeHook(ws, "workspace.setup", "foo.agent", "body\n");
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toHaveLength(2);
    // `.agent` < `.sh` alphabetically, so the agent-file fires first.
    expect(result.hooks[0]?.id).toBe("file:workspace.setup/foo.agent");
    expect(result.hooks[0]?.kind).toBe("agent-file");
    expect(result.hooks[1]?.id).toBe("file:workspace.setup/foo.sh");
    expect(result.hooks[1]?.kind).toBe("command-file");
  });

  it("does not pick up .citadel/hooks/deploy at the root (deploy is a file, not an event folder)", () => {
    const ws = makeWorkspace();
    // Drop the deploy file at hooks-root, mimicking the special-case layout.
    fs.mkdirSync(path.join(ws, ".citadel", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".citadel", "hooks", "deploy"), "#!/bin/sh\n");
    fs.chmodSync(path.join(ws, ".citadel", "hooks", "deploy"), 0o755);
    // discoverFileHooks only iterates event folders. Since `deploy` is not a
    // HookEvent and the framework caller would never pass it, no event would
    // produce a hit. Sanity-check that workspace.setup discovery (an event
    // that doesn't exist as a folder here) returns empty without surprise.
    const result = discoverFileHooks({ workspacePath: ws, event: "workspace.setup" });
    expect(result.hooks).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
});
