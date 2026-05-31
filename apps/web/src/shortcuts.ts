import { SHORTCUT_CHORDS, type ShortcutChord, type ShortcutId } from "@citadel/contracts";

export type { ShortcutChord, ShortcutId } from "@citadel/contracts";
export { FORWARDABLE_CHORDS, FORWARDABLE_SHORTCUT_IDS, SHORTCUT_CHORDS } from "@citadel/contracts";

export type ShortcutMatch = {
  id: ShortcutId;
  chord: ShortcutChord;
  index?: number;
};

// Match a native KeyboardEvent against the canonical chord table.
// Returns null when no chord matches — callers should pass through to other handlers.
//
// Modifier semantics:
//   "primary" = metaKey OR ctrlKey (Mac cmd / Linux+Win ctrl). Either is accepted.
//   "ctrl"    = ctrlKey AND NOT metaKey (used for nav-workspace so Cmd+1..9 on
//               Mac stays available to Chrome's tab-switch shortcut as the user
//               explicitly requested).
//   null      = no primary modifier required (used for plain Escape).
//
// In all cases, `altKey` must be false and `shiftKey` must match the chord exactly.
export function matchShortcut(event: KeyboardEvent): ShortcutMatch | null {
  if (event.altKey) return null;
  const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
  const isEscape = event.key === "Escape";
  for (const chord of SHORTCUT_CHORDS) {
    if (!modifierMatches(chord.modifier, event)) continue;
    if (chord.shift !== event.shiftKey) continue;
    if (chord.key === "Escape") {
      if (!isEscape) continue;
    } else if (chord.key.toLowerCase() !== key) {
      continue;
    }
    const match: ShortcutMatch = { id: chord.id, chord };
    if (chord.index !== undefined) match.index = chord.index;
    return match;
  }
  return null;
}

function modifierMatches(modifier: ShortcutChord["modifier"], event: KeyboardEvent): boolean {
  if (modifier === "primary") return event.metaKey || event.ctrlKey;
  if (modifier === "ctrl") return event.ctrlKey && !event.metaKey;
  return !event.metaKey && !event.ctrlKey;
}
