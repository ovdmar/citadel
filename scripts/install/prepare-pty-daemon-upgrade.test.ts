import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PREPARE_SCRIPT = path.join(SCRIPT_DIR, "prepare-pty-daemon-upgrade.mjs");

function runPrepare(env: NodeJS.ProcessEnv): string {
  return execFileSync(process.execPath, [PREPARE_SCRIPT], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("scripts/install/prepare-pty-daemon-upgrade.mjs", () => {
  it("skips cleanly when there is no PTY daemon socket", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-pty-upgrade-"));
    try {
      const configPath = path.join(dir, "citadel.config.json");
      fs.writeFileSync(configPath, JSON.stringify({ dataDir: dir }));
      const output = runPrepare({
        CITADEL_CONFIG: configPath,
        CITADEL_INSTALL_ROOT: dir,
      });
      expect(output).toContain(`no PTY daemon socket at ${path.join(dir, "run", "pty-daemon.sock")}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors the explicit skip switch", () => {
    const output = runPrepare({ CITADEL_SKIP_PTY_DAEMON_HANDOFF: "1" });
    expect(output).toContain("PTY daemon handoff skipped by CITADEL_SKIP_PTY_DAEMON_HANDOFF=1");
  });
});
