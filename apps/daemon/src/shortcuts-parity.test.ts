import { FORWARDABLE_CHORDS, type ShortcutChord } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { TERMINAL_KEY_SHIM_SOURCE } from "./terminal-key-shim.js";

// Behavioral parity: the iframe shim duplicates FORWARDABLE_CHORDS inline
// (it's a plain-JS IIFE injected into ttyd's HTML, no module system), and
// the source of truth for the registry is `@citadel/contracts`. This test
// evaluates the shim source in a controlled scope, captures the shim's
// exposed `matchForwardable`, and asserts both sides classify a curated
// truth-table of inputs identically. Drift in source formatting doesn't
// break the test — drift in actual logic does.

type ShimMatch = { id: string; index?: number };
type ShimDebug = {
  matchForwardable: (event: Record<string, unknown>) => ShimMatch | null;
  FORWARDABLE_CHORDS: ReadonlyArray<ShortcutChord>;
};

function loadShimDebug(): ShimDebug {
  const fakeNavigator = { platform: "MacIntel", userAgent: "MacIntel", clipboard: {} };
  // The shim references many browser globals we don't need for matcher
  // evaluation. We provide minimal stubs and let the eval'd IIFE assign
  // `__citadelTerminalShimDebug` onto our `window` stub.
  const win: Record<string, unknown> = {
    WebSocket: class FakeWS {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: unknown[] = [];
      addEventListener() {}
      send() {}
    },
    addEventListener() {},
    KeyboardEvent: class FakeKE {
      constructor(
        public type: string,
        public init: Record<string, unknown>,
      ) {}
    },
    dispatchEvent() {
      return true;
    },
    term: undefined,
  };
  const doc = {
    addEventListener() {},
    querySelector() {
      return null;
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("window", "document", "navigator", "TextEncoder", TERMINAL_KEY_SHIM_SOURCE)(
    win,
    doc,
    fakeNavigator,
    TextEncoder,
  );
  const debug = win.__citadelTerminalShimDebug as ShimDebug | undefined;
  if (!debug) throw new Error("shim did not expose __citadelTerminalShimDebug");
  return debug;
}

function eventFor(chord: ShortcutChord): Record<string, unknown> {
  return {
    key: chord.key,
    metaKey: chord.modifier === "primary",
    ctrlKey: chord.modifier === "ctrl",
    shiftKey: chord.shift,
    altKey: false,
  };
}

describe("shim ↔ contracts FORWARDABLE_CHORDS parity", () => {
  const shim = loadShimDebug();

  it("shim's FORWARDABLE_CHORDS has the same length as the contracts table", () => {
    expect(shim.FORWARDABLE_CHORDS.length).toBe(FORWARDABLE_CHORDS.length);
  });

  it("every shim chord is matched by the contracts matcher with the same id (inverse direction)", () => {
    // Parity is two-way. If the shim ever ADDED a chord without updating
    // contracts (or vice versa), the length test would still pass when both
    // also dropped something else. Iterate the shim side and ensure the
    // canonical contracts FORWARDABLE_CHORDS contains a matching descriptor
    // by id/key/modifier/shift/index.
    for (const chord of shim.FORWARDABLE_CHORDS) {
      const match = FORWARDABLE_CHORDS.find(
        (c) =>
          c.id === chord.id &&
          c.key === chord.key &&
          c.modifier === chord.modifier &&
          c.shift === chord.shift &&
          (c.index ?? null) === (chord.index ?? null),
      );
      expect(match, `shim chord ${chord.id} (${chord.key}) has no counterpart in contracts`).toBeDefined();
    }
  });

  it("every contracts chord is matched by the shim with the same id", () => {
    for (const chord of FORWARDABLE_CHORDS) {
      const event = eventFor(chord);
      const result = shim.matchForwardable(event);
      expect(result, `${chord.id} (${chord.key})`).not.toBeNull();
      expect(result?.id, `${chord.id} (${chord.key})`).toBe(chord.id);
      if (chord.index !== undefined) {
        expect(result?.index, `${chord.id} (${chord.key})`).toBe(chord.index);
      }
    }
  });

  it("curated negative inputs are not matched by the shim", () => {
    const negatives: Array<Record<string, unknown>> = [
      // Plain letters / digits.
      { key: "c" },
      { key: "k" },
      { key: "t" },
      { key: "e" },
      { key: "1" },
      { key: "5" },
      // Shift+digit (required for typing !@#$%).
      { key: "1", shiftKey: true },
      { key: "5", shiftKey: true },
      // Cmd+1 (Chrome owns it on Mac).
      { key: "1", metaKey: true },
      // Alt-combined chords are reserved.
      { key: "k", metaKey: true, altKey: true },
      // Shift+Enter is the LF translation, not a forwardable.
      { key: "Enter", shiftKey: true },
      // Ctrl+A is the SOH translation, not a forwardable.
      { key: "a", ctrlKey: true },
      // Cmd+C/V/A are clipboard translations, not forwardables.
      { key: "c", metaKey: true },
      { key: "v", metaKey: true },
      { key: "a", metaKey: true },
    ];
    for (const event of negatives) {
      expect(shim.matchForwardable(event), JSON.stringify(event)).toBeNull();
    }
  });
});
