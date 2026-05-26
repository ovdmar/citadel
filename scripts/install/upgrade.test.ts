import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Tests for scripts/install/upgrade.sh — the validated, refusal-friendly
// wrapper around scripts/install-systemd.sh. We never actually invoke
// systemctl; the tests stop at the refusal points the script enforces
// BEFORE any state-mutating action.

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE_SCRIPT = path.join(SCRIPT_DIR, "upgrade.sh");

type RunResult = { code: number; stdout: string; stderr: string };

// Wrapper around bash that captures exit code + streams instead of throwing.
function runUpgrade(args: string[], env: NodeJS.ProcessEnv): RunResult {
  try {
    const stdout = execFileSync("bash", [UPGRADE_SCRIPT, ...args], {
      env: { ...process.env, ...env, CITADEL_UPGRADE_TEST: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      code: e.status ?? -1,
      stdout: (e.stdout ?? "").toString(),
      stderr: (e.stderr ?? "").toString(),
    };
  }
}

// Build a tmp dir that *looks* like a Citadel checkout (just enough for the
// `apps/daemon` existence check) and a fake systemd unit file at a
// caller-controlled path that the test can point upgrade.sh at via env.
function makeFakeCheckout(): {
  root: string;
  fakeUnit: string;
  cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-upgrade-test-"));
  fs.mkdirSync(path.join(root, "apps", "daemon"), { recursive: true });
  // Initialise an empty git repo so `git status --porcelain` returns
  // sensibly (no uncommitted changes against an empty index).
  execFileSync("git", ["init", "-q", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "config", "user.name", "test"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "--allow-empty", "-m", "init"], { stdio: "ignore" });
  const fakeUnit = path.join(root, "citadel.service");
  fs.writeFileSync(
    fakeUnit,
    [
      "[Unit]",
      "Description=Citadel local operator cockpit",
      "[Service]",
      `WorkingDirectory=${root}`,
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
  return {
    root,
    fakeUnit,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe("scripts/install/upgrade.sh — refusal contracts", () => {
  let env: { root: string; fakeUnit: string; cleanup: () => void };

  beforeEach(() => {
    env = makeFakeCheckout();
  });

  afterEach(() => {
    env.cleanup();
  });

  it("refuses to run from a directory that isn't a Citadel checkout", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "not-citadel-"));
    try {
      const result = runUpgrade([], {
        CITADEL_INSTALL_ROOT: outsideRoot,
        CITADEL_SERVICE_UNIT: env.fakeUnit,
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/does not look like a Citadel checkout/i);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("refuses an invalid REF (regex mismatch)", () => {
    const result = runUpgrade(["REF=v0.3.O"], {
      CITADEL_INSTALL_ROOT: env.root,
      CITADEL_SERVICE_UNIT: env.fakeUnit,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/ref must match/i);
  });

  it("refuses a REF that isn't an annotated tag (e.g., a branch name)", () => {
    // The REF passes the regex shape, but we don't create a matching tag.
    // git cat-file should fail → upgrade.sh refuses.
    const result = runUpgrade(["REF=v9.9.9"], {
      CITADEL_INSTALL_ROOT: env.root,
      CITADEL_SERVICE_UNIT: env.fakeUnit,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/annotated tag|cat-file|not found/i);
  });

  it("refuses when WorkingDirectory= differs from current install root", () => {
    // Write a fake unit pointing at /tmp/some-other-citadel and ask upgrade.sh
    // to run from env.root — it must refuse with both paths in the error.
    const otherUnit = path.join(env.root, "wrong-unit.service");
    fs.writeFileSync(
      otherUnit,
      ["[Service]", "WorkingDirectory=/tmp/some-other-citadel", ""].join("\n"),
    );
    const result = runUpgrade([], {
      CITADEL_INSTALL_ROOT: env.root,
      CITADEL_SERVICE_UNIT: otherUnit,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/working.?directory|workingdirectory/i);
    expect(result.stderr + result.stdout).toContain("/tmp/some-other-citadel");
    expect(result.stderr + result.stdout).toContain(env.root);
  });

  it("refuses to pin a REF when the working tree is dirty", () => {
    // Create an annotated tag and then dirty the worktree.
    execFileSync("git", ["-C", env.root, "tag", "-a", "v0.3.0", "-m", "v0.3.0"], { stdio: "ignore" });
    fs.writeFileSync(path.join(env.root, "DIRTY"), "uncommitted change\n");
    const result = runUpgrade(["REF=v0.3.0"], {
      CITADEL_INSTALL_ROOT: env.root,
      CITADEL_SERVICE_UNIT: env.fakeUnit,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/dirty|uncommitted/i);
  });
});
