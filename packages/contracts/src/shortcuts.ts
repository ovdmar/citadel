// Canonical shortcut-chord table. Data-only — no React, no node imports — so
// it can be consumed by both apps/web (browser runtime) and apps/daemon (the
// shim parity test) without crossing architecture boundaries.

export type ShortcutId =
  | "command-palette"
  | "new-workspace-modal"
  | "nav-workspace"
  | "nav-session"
  | "spawn-terminal"
  | "spawn-agent"
  | "close-overlay";

// "primary" matches metaKey OR ctrlKey (Mac cmd / Linux+Win ctrl).
// "ctrl" matches ctrlKey AND NOT metaKey — used for workspace nav so cmd+1..9
//        on Mac stays available to Chrome's tab-switch shortcut as intended.
// null  means no primary modifier (used for plain Escape).
export type ChordModifier = "primary" | "ctrl" | null;

export type ShortcutChord = {
  id: ShortcutId;
  modifier: ChordModifier;
  shift: boolean;
  // The canonical KeyboardEvent.key (lowercased for letters; "Escape" for
  // Escape; "0".."9" for digits). Match logic lowercases incoming keys.
  key: string;
  // For nav-workspace / nav-session: 1..9 maps to index 0..8; "0" maps to
  // index 9 (so Ctrl+0 jumps to the 10th workspace).
  index?: number;
};

// Build the digit-indexed chord list once so both nav families stay in sync.
const digitNavChords = (
  id: "nav-workspace" | "nav-session",
  modifier: ChordModifier,
  shift: boolean,
): ShortcutChord[] => {
  const out: ShortcutChord[] = [];
  for (let n = 1; n <= 9; n += 1) {
    out.push({ id, modifier, shift, key: String(n), index: n - 1 });
  }
  if (id === "nav-workspace") {
    out.push({ id, modifier, shift, key: "0", index: 9 });
  }
  return out;
};

// Every chord the cockpit cares about — registry consumers iterate this.
export const SHORTCUT_CHORDS: ReadonlyArray<ShortcutChord> = Object.freeze([
  { id: "command-palette", modifier: "primary", shift: false, key: "k" },
  { id: "spawn-terminal", modifier: "primary", shift: false, key: "t" },
  { id: "spawn-agent", modifier: "primary", shift: false, key: "e" },
  ...digitNavChords("nav-workspace", "ctrl", false),
  ...digitNavChords("nav-session", "primary", true),
  { id: "close-overlay", modifier: null, shift: false, key: "Escape" },
]);

// Subset the iframe shim is allowed to forward to window.parent.
// All entries that need to reach the cockpit even when xterm has focus.
export const FORWARDABLE_SHORTCUT_IDS: ReadonlySet<ShortcutId> = new Set<ShortcutId>([
  "command-palette",
  "nav-workspace",
  "nav-session",
  "spawn-terminal",
  "spawn-agent",
  "close-overlay",
]);

export const FORWARDABLE_CHORDS: ReadonlyArray<ShortcutChord> = Object.freeze(
  SHORTCUT_CHORDS.filter((chord) => FORWARDABLE_SHORTCUT_IDS.has(chord.id)),
);
