import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const LOCK_ROOT = path.join(os.tmpdir(), "citadel-e2e-locks");
const STALE_LOCK_MS = 5 * 60_000;
const WAIT_TIMEOUT_MS = 5 * 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireSharedStateLock(name: string, owner: string): Promise<() => void> {
  fs.mkdirSync(LOCK_ROOT, { recursive: true });
  const lockDir = path.join(LOCK_ROOT, `${name}.lock`);
  const start = Date.now();

  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(
        path.join(lockDir, "owner.json"),
        JSON.stringify({ owner, pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
      );
      let released = false;
      return () => {
        if (released) return;
        released = true;
        fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(100);
    }
  }

  throw new Error(`Timed out waiting for ${name} shared-state lock`);
}
