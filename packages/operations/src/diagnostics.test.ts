import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDiagnosticsLogger, noopDiagnosticsLogger } from "./diagnostics.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-diag-"));
  dirs.push(d);
  return d;
}

describe("createDiagnosticsLogger", () => {
  it("keeps the in-memory ring bounded and ordered oldest→newest", () => {
    const logger = createDiagnosticsLogger({ maxRingEvents: 3 });
    logger.log("test", "a");
    logger.log("test", "b");
    logger.log("test", "c");
    logger.log("test", "d");
    const events = logger.recent();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event)).toEqual(["b", "c", "d"]);
  });

  it("appends one JSON line per event to the configured file", () => {
    const dataDir = tmp();
    const logger = createDiagnosticsLogger({ dataDir });
    logger.log("tmux", "kill", { tmuxSession: "citadel_x" });
    logger.log("terminal", "attach", { key: "sess_1" });
    const text = fs.readFileSync(path.join(dataDir, "diagnostics.jsonl"), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0] ?? "");
    const b = JSON.parse(lines[1] ?? "");
    expect(a.category).toBe("tmux");
    expect(a.event).toBe("kill");
    expect(a.data).toEqual({ tmuxSession: "citadel_x" });
    expect(b.category).toBe("terminal");
    expect(b.data).toEqual({ key: "sess_1" });
    expect(typeof a.ts).toBe("string");
    expect(new Date(a.ts).toString()).not.toBe("Invalid Date");
  });

  it("noopDiagnosticsLogger does nothing and reports null paths", () => {
    noopDiagnosticsLogger.log("a", "b", { foo: 1 });
    expect(noopDiagnosticsLogger.recent()).toEqual([]);
    expect(noopDiagnosticsLogger.filePath()).toBeNull();
    expect(noopDiagnosticsLogger.rotatedPath()).toBeNull();
  });
});
