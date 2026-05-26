import { FORWARDABLE_CHORDS, SHORTCUT_CHORDS } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { type ShortcutMatch, matchShortcut } from "./shortcuts.js";

// Builds a minimal KeyboardEvent-shaped object the matcher can read. We can
// not use the global KeyboardEvent constructor in node env so we lean on the
// fact that matchShortcut only reads { key, metaKey, ctrlKey, shiftKey, altKey }.
function ev(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}): KeyboardEvent {
  return {
    key: init.key,
    metaKey: !!init.metaKey,
    ctrlKey: !!init.ctrlKey,
    shiftKey: !!init.shiftKey,
    altKey: !!init.altKey,
  } as unknown as KeyboardEvent;
}

describe("matchShortcut", () => {
  it("matches Cmd+K on macOS (metaKey)", () => {
    const match = matchShortcut(ev({ key: "k", metaKey: true }));
    expect(match?.id).toBe("command-palette");
  });

  it("matches Ctrl+K on non-macOS (ctrlKey)", () => {
    const match = matchShortcut(ev({ key: "k", ctrlKey: true }));
    expect(match?.id).toBe("command-palette");
  });

  it("matches Ctrl+1..Ctrl+9 as nav-workspace with the correct index", () => {
    for (let n = 1; n <= 9; n += 1) {
      const match = matchShortcut(ev({ key: String(n), ctrlKey: true }));
      expect(match?.id).toBe("nav-workspace");
      expect(match?.index).toBe(n - 1);
    }
  });

  it("matches Ctrl+0 as nav-workspace index 9 (10th workspace)", () => {
    const match = matchShortcut(ev({ key: "0", ctrlKey: true }));
    expect(match?.id).toBe("nav-workspace");
    expect(match?.index).toBe(9);
  });

  it("does NOT match Cmd+1 — Chrome owns it on Mac, we explicitly don't fight it", () => {
    expect(matchShortcut(ev({ key: "1", metaKey: true }))).toBeNull();
  });

  it("matches Cmd+Shift+1..Cmd+Shift+9 as nav-session on macOS", () => {
    for (let n = 1; n <= 9; n += 1) {
      const match = matchShortcut(ev({ key: String(n), metaKey: true, shiftKey: true }));
      expect(match?.id).toBe("nav-session");
      expect(match?.index).toBe(n - 1);
    }
  });

  it("matches Ctrl+Shift+1..Ctrl+Shift+9 as nav-session on non-macOS", () => {
    for (let n = 1; n <= 9; n += 1) {
      const match = matchShortcut(ev({ key: String(n), ctrlKey: true, shiftKey: true }));
      expect(match?.id).toBe("nav-session");
      expect(match?.index).toBe(n - 1);
    }
  });

  it("matches Cmd+T as spawn-terminal", () => {
    expect(matchShortcut(ev({ key: "t", metaKey: true }))?.id).toBe("spawn-terminal");
    expect(matchShortcut(ev({ key: "t", ctrlKey: true }))?.id).toBe("spawn-terminal");
  });

  it("matches Cmd+E as spawn-agent", () => {
    expect(matchShortcut(ev({ key: "e", metaKey: true }))?.id).toBe("spawn-agent");
    expect(matchShortcut(ev({ key: "e", ctrlKey: true }))?.id).toBe("spawn-agent");
  });

  it("matches plain Escape as close-overlay", () => {
    expect(matchShortcut(ev({ key: "Escape" }))?.id).toBe("close-overlay");
  });

  it("does NOT match Escape with any modifier", () => {
    expect(matchShortcut(ev({ key: "Escape", metaKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "Escape", ctrlKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "Escape", shiftKey: true }))).toBeNull();
  });

  it("does NOT match plain letters or digits (no modifier)", () => {
    expect(matchShortcut(ev({ key: "c" }))).toBeNull();
    expect(matchShortcut(ev({ key: "k" }))).toBeNull();
    expect(matchShortcut(ev({ key: "1" }))).toBeNull();
    expect(matchShortcut(ev({ key: "5" }))).toBeNull();
  });

  it("does NOT match Shift+1 — required for typing '!' in xterm", () => {
    expect(matchShortcut(ev({ key: "1", shiftKey: true }))).toBeNull();
    expect(matchShortcut(ev({ key: "!", shiftKey: true }))).toBeNull();
  });

  it("does NOT match if Alt is set — alt+key chords are reserved for future use", () => {
    expect(matchShortcut(ev({ key: "k", metaKey: true, altKey: true }))).toBeNull();
  });

  it("case-insensitive on letters (Cmd+Shift+K still matches command-palette via primary modifier)", () => {
    expect(matchShortcut(ev({ key: "K", metaKey: true }))?.id).toBe("command-palette");
  });

  it("never matches more than one chord (every registry entry is uniquely keyed)", () => {
    const seen = new Set<string>();
    for (const chord of SHORTCUT_CHORDS) {
      const signature = `${chord.modifier}|${chord.shift}|${chord.key.toLowerCase()}|${chord.index ?? ""}`;
      expect(seen.has(signature), `duplicate chord signature: ${signature}`).toBe(false);
      seen.add(signature);
    }
  });

  it("FORWARDABLE_CHORDS is a subset of SHORTCUT_CHORDS", () => {
    for (const chord of FORWARDABLE_CHORDS) {
      expect(SHORTCUT_CHORDS).toContain(chord);
    }
  });

  it("returns a ShortcutMatch with the underlying chord descriptor", () => {
    const match = matchShortcut(ev({ key: "k", metaKey: true })) as ShortcutMatch;
    expect(match.chord.id).toBe("command-palette");
    expect(match.chord.key).toBe("k");
  });
});
