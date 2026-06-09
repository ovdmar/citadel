import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_REFINE_SCRATCHPAD,
  CannotDeleteBuiltInError,
  CitadelActionNotFoundError,
  StaleUpdatedAtError,
  createCitadelAction,
  deleteCitadelAction,
  listCitadelActions,
  resetCitadelAction,
  updateCitadelAction,
} from "./citadel-actions.js";

describe("citadel-actions storage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-actions-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("seeds the built-in refine-scratchpad action on first read", async () => {
    const list = await listCitadelActions(dataDir);
    expect(list).toHaveLength(1);
    const seeded = list[0];
    expect(seeded?.id).toBe(BUILT_IN_REFINE_SCRATCHPAD.id);
    expect(seeded?.builtIn).toBe(true);
    expect(seeded?.promptTemplate).toBe(BUILT_IN_REFINE_SCRATCHPAD.promptTemplate);
    expect(seeded?.runtimeId).toBe("claude-code");
    expect(seeded?.updatedAt).toMatch(/Z$/);
  });

  it("seeds again if the file is wiped between reads", async () => {
    await listCitadelActions(dataDir);
    fs.unlinkSync(path.join(dataDir, "citadel-actions.json"));
    const list = await listCitadelActions(dataDir);
    expect(list.some((a) => a.id === BUILT_IN_REFINE_SCRATCHPAD.id)).toBe(true);
  });

  it("creates a custom action and round-trips it", async () => {
    await listCitadelActions(dataDir);
    const created = await createCitadelAction(dataDir, {
      name: "Summarize",
      promptTemplate: "summarize the scratchpad",
    });
    expect(created.builtIn).toBe(false);
    expect(created.id).not.toBe(BUILT_IN_REFINE_SCRATCHPAD.id);
    expect(created.runtimeId).toBe("claude-code");
    const list = await listCitadelActions(dataDir);
    expect(list.some((a) => a.id === created.id)).toBe(true);
  });

  it("updates a built-in's prompt and preferred runtime, then persists", async () => {
    const [seeded] = await listCitadelActions(dataDir);
    if (!seeded) throw new Error("expected seeded action");
    const updated = await updateCitadelAction(dataDir, seeded.id, {
      promptTemplate: "custom override prompt",
      runtimeId: "codex",
      updatedAt: seeded.updatedAt,
    });
    expect(updated.promptTemplate).toBe("custom override prompt");
    expect(updated.runtimeId).toBe("codex");
    expect(updated.updatedAt).not.toBe(seeded.updatedAt);
    const list = await listCitadelActions(dataDir);
    expect(list.find((a) => a.id === seeded.id)?.promptTemplate).toBe("custom override prompt");
    expect(list.find((a) => a.id === seeded.id)?.runtimeId).toBe("codex");
  });

  it("rejects a stale PUT with StaleUpdatedAtError", async () => {
    const [seeded] = await listCitadelActions(dataDir);
    if (!seeded) throw new Error("expected seeded action");
    await updateCitadelAction(dataDir, seeded.id, {
      promptTemplate: "v1",
      updatedAt: seeded.updatedAt,
    });
    await expect(
      updateCitadelAction(dataDir, seeded.id, {
        promptTemplate: "v2",
        updatedAt: seeded.updatedAt, // stale!
      }),
    ).rejects.toBeInstanceOf(StaleUpdatedAtError);
  });

  it("reset restores the built-in default", async () => {
    const [seeded] = await listCitadelActions(dataDir);
    if (!seeded) throw new Error("expected seeded action");
    await updateCitadelAction(dataDir, seeded.id, {
      promptTemplate: "off the rails",
      updatedAt: seeded.updatedAt,
    });
    const reset = await resetCitadelAction(dataDir, seeded.id);
    expect(reset.promptTemplate).toBe(BUILT_IN_REFINE_SCRATCHPAD.promptTemplate);
    expect(reset.runtimeId).toBe(BUILT_IN_REFINE_SCRATCHPAD.runtimeId);
    expect(reset.builtIn).toBe(true);
  });

  it("backfills the preferred runtime for existing action files", async () => {
    const filePath = path.join(dataDir, "citadel-actions.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        actions: [
          {
            id: BUILT_IN_REFINE_SCRATCHPAD.id,
            name: BUILT_IN_REFINE_SCRATCHPAD.name,
            description: BUILT_IN_REFINE_SCRATCHPAD.description,
            icon: BUILT_IN_REFINE_SCRATCHPAD.icon,
            promptTemplate: "old prompt",
            builtIn: true,
            updatedAt: "2026-05-29T00:00:00.000Z",
          },
        ],
      }),
    );

    const [action] = await listCitadelActions(dataDir);

    expect(action?.runtimeId).toBe("claude-code");
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8")) as { actions: Array<{ runtimeId?: string }> };
    expect(stored.actions[0]?.runtimeId).toBe("claude-code");
  });

  it("cannot delete a built-in", async () => {
    const [seeded] = await listCitadelActions(dataDir);
    if (!seeded) throw new Error("expected seeded action");
    await expect(deleteCitadelAction(dataDir, seeded.id)).rejects.toBeInstanceOf(CannotDeleteBuiltInError);
  });

  it("delete on unknown id throws CitadelActionNotFoundError", async () => {
    await expect(deleteCitadelAction(dataDir, "nope")).rejects.toBeInstanceOf(CitadelActionNotFoundError);
  });

  it("serializes concurrent writes via mutex (last write wins, file integrity preserved)", async () => {
    const [seeded] = await listCitadelActions(dataDir);
    if (!seeded) throw new Error("expected seeded action");
    // First write resolves; the second sees a stale updatedAt and rejects.
    const [first, second] = await Promise.allSettled([
      updateCitadelAction(dataDir, seeded.id, { promptTemplate: "A", updatedAt: seeded.updatedAt }),
      updateCitadelAction(dataDir, seeded.id, { promptTemplate: "B", updatedAt: seeded.updatedAt }),
    ]);
    // One fulfills, the other rejects with StaleUpdatedAtError. Either order
    // is valid — the mutex serializes them.
    const fulfilled = [first, second].filter((r) => r.status === "fulfilled");
    const rejected = [first, second].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(StaleUpdatedAtError);
    }
    // File on disk has exactly one of the two values; no torn merge.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, "citadel-actions.json"), "utf8")) as {
      actions: Array<{ id: string; promptTemplate: string }>;
    };
    const final = stored.actions.find((a) => a.id === seeded.id)?.promptTemplate;
    expect(["A", "B"]).toContain(final);
  });
});
