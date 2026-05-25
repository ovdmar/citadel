import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

// Per-worktree dev state, written to `<worktree>/.citadel/dev.json`. Lets the
// daemon, Makefile, and deploy hook agree on which port/host the worktree's
// stack is actually listening on after EADDRINUSE fallback. The cksum formula
// alone is not enough — at ~15 worktrees the birthday paradox starts producing
// collisions, and the second daemon would just fail to bind.
export const DevStateSchema = z.object({
  port: z.number().int().min(1).max(65535),
  webPort: z.number().int().min(1).max(65535).optional(),
  host: z.string().min(1).default("127.0.0.1"),
  worktreePath: z.string().min(1),
  writtenAt: z.string().min(1),
});

export type DevState = z.infer<typeof DevStateSchema>;

export function devStatePath(worktreeRoot: string) {
  return path.join(worktreeRoot, ".citadel", "dev.json");
}

export function loadDevState(worktreeRoot: string): DevState | null {
  const file = devStatePath(worktreeRoot);
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = DevStateSchema.safeParse(JSON.parse(fs.readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function saveDevState(worktreeRoot: string, state: Omit<DevState, "writtenAt">): DevState {
  const file = devStatePath(worktreeRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const next = DevStateSchema.parse({ ...state, writtenAt: new Date().toISOString() });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

// Walk up from `start` until we find a `.citadel/` directory next to either
// `.git/` (main checkout) or `.git` file (worktree gitlink). Returns null when
// run outside any Citadel checkout — callers fall back to env-only resolution.
export function resolveWorktreeRoot(start: string = process.cwd()): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".citadel")) && fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
