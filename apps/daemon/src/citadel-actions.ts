// Citadel Actions — configurable prompt presets stored at
// `<dataDir>/citadel-actions.json`. Surfaced in Settings; consumed by the
// scratchpad's Refine button and the `refine_scratchpad` MCP tool.
//
// Writes are serialized through a per-dataDir promise queue so two concurrent
// PUTs from two browser tabs don't tear the file. `updatedAt` on each action
// provides stale-write protection on top of the mutex: a client PUT must
// supply the `updatedAt` it last saw, and the daemon returns
// `stale_updated_at` if storage has moved on.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CitadelAction } from "@citadel/contracts";

const FILENAME = "citadel-actions.json";
const BUILT_IN_REFINE_PROMPT = `You are working on a Citadel scratchpad — a markdown file split into UUID-fenced blocks.
Use the citadel MCP server's read_scratchpad / list_blocks tools to read the current state.

Task: deduplicate similar items, group related items together, and tidy formatting.
NEVER touch blocks whose text begins with a status header line ending in \`\`in-progress\`\`
(format: \`**<title>** — \`in-progress\`\`) — those blocks are owned by other agents and
must be left untouched.

Use update_block / add_block / delete_block to apply your changes. Do not call
write_scratchpad (which would clobber concurrent edits).`;

// Frozen so reset always reproduces the seeded action byte-for-byte (modulo
// the regenerated `updatedAt`).
export const BUILT_IN_REFINE_SCRATCHPAD = Object.freeze({
  id: "refine-scratchpad",
  name: "Refine scratchpad",
  description: "Dedupe, group, and tidy the scratchpad. Skips blocks marked in-progress.",
  icon: "Wand2",
  promptTemplate: BUILT_IN_REFINE_PROMPT,
  builtIn: true,
} as const);

export type StoredCitadelActions = { actions: CitadelAction[] };

export class StaleUpdatedAtError extends Error {
  constructor() {
    super("stale_updated_at");
    this.name = "StaleUpdatedAtError";
  }
}

export class CitadelActionNotFoundError extends Error {
  constructor(public readonly id: string) {
    super("action_not_found");
    this.name = "CitadelActionNotFoundError";
  }
}

export class CannotDeleteBuiltInError extends Error {
  constructor() {
    super("built_in_action_cannot_be_deleted");
    this.name = "CannotDeleteBuiltInError";
  }
}

// Per-dataDir promise queue. Sequential write semantics: every write awaits
// the prior write so the file content reflects an unambiguous last-write-wins
// chain rather than torn merges.
const queues = new Map<string, Promise<unknown>>();
function withMutex<T>(dataDir: string, fn: () => Promise<T> | T): Promise<T> {
  const prior = queues.get(dataDir) ?? Promise.resolve();
  const next = prior.then(fn, fn);
  queues.set(
    dataDir,
    next.catch(() => undefined),
  );
  return next as Promise<T>;
}

function actionsPath(dataDir: string): string {
  return path.join(dataDir, FILENAME);
}

// Monotonic timestamp generator — two writes inside the same millisecond
// produce strictly increasing ISO strings so the `updatedAt` stale-write
// check (and downstream "is this newer than X" comparisons) remain ordered
// even under tight test loops.
let lastTs = "";
function nowIso(): string {
  let ts = new Date().toISOString();
  if (ts <= lastTs) {
    // Bump the ms component by 1 until strictly greater than the prior value.
    const next = new Date(Date.parse(lastTs) + 1).toISOString();
    ts = next;
  }
  lastTs = ts;
  return ts;
}

function newId(): string {
  return randomUUID();
}

function seedBuiltIns(): CitadelAction[] {
  return [
    {
      id: BUILT_IN_REFINE_SCRATCHPAD.id,
      name: BUILT_IN_REFINE_SCRATCHPAD.name,
      description: BUILT_IN_REFINE_SCRATCHPAD.description,
      icon: BUILT_IN_REFINE_SCRATCHPAD.icon,
      promptTemplate: BUILT_IN_REFINE_SCRATCHPAD.promptTemplate,
      builtIn: true,
      updatedAt: nowIso(),
    },
  ];
}

function readRaw(dataDir: string): StoredCitadelActions {
  const filePath = actionsPath(dataDir);
  if (!existsSync(filePath)) {
    return { actions: [] };
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.trim().length === 0) return { actions: [] };
  const parsed = JSON.parse(raw) as Partial<StoredCitadelActions>;
  return { actions: Array.isArray(parsed.actions) ? (parsed.actions as CitadelAction[]) : [] };
}

function writeRaw(dataDir: string, store: StoredCitadelActions): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const filePath = actionsPath(dataDir);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  // Atomic replace: a reader sees either old or new content, never partial.
  renameSync(tmp, filePath);
}

// Public surface ---------------------------------------------------------------

export async function listCitadelActions(dataDir: string): Promise<CitadelAction[]> {
  return withMutex(dataDir, () => {
    const store = readRaw(dataDir);
    let mutated = false;
    // Seed built-ins on first read or if they were somehow removed.
    if (!store.actions.some((a) => a.id === BUILT_IN_REFINE_SCRATCHPAD.id)) {
      store.actions.unshift(...seedBuiltIns());
      mutated = true;
    }
    if (mutated) writeRaw(dataDir, store);
    return store.actions.slice();
  });
}

export async function createCitadelAction(
  dataDir: string,
  input: { name: string; description?: string; icon?: string; promptTemplate: string },
): Promise<CitadelAction> {
  return withMutex(dataDir, () => {
    const store = readRaw(dataDir);
    const action: CitadelAction = {
      id: newId(),
      name: input.name,
      description: input.description ?? "",
      icon: input.icon ?? "",
      promptTemplate: input.promptTemplate,
      builtIn: false,
      updatedAt: nowIso(),
    };
    store.actions.push(action);
    writeRaw(dataDir, store);
    return action;
  });
}

export async function updateCitadelAction(
  dataDir: string,
  id: string,
  input: {
    name?: string | undefined;
    description?: string | undefined;
    icon?: string | undefined;
    promptTemplate?: string | undefined;
    updatedAt: string;
  },
): Promise<CitadelAction> {
  return withMutex(dataDir, () => {
    const store = readRaw(dataDir);
    const existing = store.actions.find((a) => a.id === id);
    if (!existing) throw new CitadelActionNotFoundError(id);
    if (existing.updatedAt !== input.updatedAt) throw new StaleUpdatedAtError();
    const next: CitadelAction = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      icon: input.icon ?? existing.icon,
      promptTemplate: input.promptTemplate ?? existing.promptTemplate,
      updatedAt: nowIso(),
    };
    store.actions = store.actions.map((a) => (a.id === id ? next : a));
    writeRaw(dataDir, store);
    return next;
  });
}

export async function deleteCitadelAction(dataDir: string, id: string): Promise<void> {
  return withMutex(dataDir, () => {
    const store = readRaw(dataDir);
    const existing = store.actions.find((a) => a.id === id);
    if (!existing) throw new CitadelActionNotFoundError(id);
    if (existing.builtIn) throw new CannotDeleteBuiltInError();
    store.actions = store.actions.filter((a) => a.id !== id);
    writeRaw(dataDir, store);
  });
}

export async function resetCitadelAction(dataDir: string, id: string): Promise<CitadelAction> {
  return withMutex(dataDir, () => {
    const store = readRaw(dataDir);
    const existing = store.actions.find((a) => a.id === id);
    if (!existing) throw new CitadelActionNotFoundError(id);
    if (id === BUILT_IN_REFINE_SCRATCHPAD.id) {
      const seeded: CitadelAction = {
        id: BUILT_IN_REFINE_SCRATCHPAD.id,
        name: BUILT_IN_REFINE_SCRATCHPAD.name,
        description: BUILT_IN_REFINE_SCRATCHPAD.description,
        icon: BUILT_IN_REFINE_SCRATCHPAD.icon,
        promptTemplate: BUILT_IN_REFINE_SCRATCHPAD.promptTemplate,
        builtIn: true,
        updatedAt: nowIso(),
      };
      store.actions = store.actions.map((a) => (a.id === id ? seeded : a));
      writeRaw(dataDir, store);
      return seeded;
    }
    // Custom actions don't have a "factory default" — reset is a no-op.
    return existing;
  });
}

export async function getCitadelAction(dataDir: string, id: string): Promise<CitadelAction | null> {
  const all = await listCitadelActions(dataDir);
  return all.find((a) => a.id === id) ?? null;
}
