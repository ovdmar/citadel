import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemePrefStore, parseTheme } from "./terminal-routes.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-theme-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("parseTheme", () => {
  it("returns the value for 'light' and 'dark'", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("returns undefined for empty / null / undefined without logging", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTheme(undefined)).toBeUndefined();
    expect(parseTheme(null)).toBeUndefined();
    expect(parseTheme("")).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns undefined AND logs a warning for unrecognized values (e.g. 'system')", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseTheme("system")).toBeUndefined();
    expect(parseTheme("midnight")).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain("system");
    expect(warn.mock.calls[1]?.[0]).toContain("midnight");
  });
});

describe("ThemePrefStore", () => {
  it("persists theme to disk and round-trips on reload", () => {
    const dir = mkTmp();
    const a = new ThemePrefStore(dir);
    a.set("session-1", "light");
    a.set("session-2", "dark");

    const file = path.join(dir, "terminal-theme-prefs.json");
    expect(fs.existsSync(file)).toBe(true);

    const b = new ThemePrefStore(dir);
    expect(b.get("session-1")).toBe("light");
    expect(b.get("session-2")).toBe("dark");
  });

  it("returns undefined for unknown sessions", () => {
    const store = new ThemePrefStore(mkTmp());
    expect(store.get("never-set")).toBeUndefined();
  });

  it("ignores corrupt sidecar JSON without crashing", () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, "terminal-theme-prefs.json"), "{not json");
    const store = new ThemePrefStore(dir);
    expect(store.get("anything")).toBeUndefined();
    // The next set() should still work and overwrite the file cleanly.
    store.set("session-1", "light");
    expect(new ThemePrefStore(dir).get("session-1")).toBe("light");
  });

  it("filters out non-theme values during load (defends against manual file edits)", () => {
    const dir = mkTmp();
    fs.writeFileSync(
      path.join(dir, "terminal-theme-prefs.json"),
      JSON.stringify({ a: "light", b: "system", c: 42, d: "dark" }),
    );
    // The constructor calls parseTheme internally; "system" + 42 trigger the
    // unrecognized-value warning path. Suppress so it doesn't pollute output.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = new ThemePrefStore(dir);
    expect(store.get("a")).toBe("light");
    expect(store.get("b")).toBeUndefined();
    expect(store.get("c")).toBeUndefined();
    expect(store.get("d")).toBe("dark");
    expect(warn).toHaveBeenCalled();
  });
});
