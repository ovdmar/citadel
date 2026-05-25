// Append a transcript chunk to existing composer/editor text. Pure function so
// composer, per-block editor, and any future voice surface share the same
// leading-space semantics. The daemon-served quick-capture page has its own
// inline copy (it can't import this) — its semantics are kept in sync by
// convention; see apps/daemon/src/quick-capture-route.ts for the shadow
// implementation.
export function appendTranscript(existing: string, addition: string): string {
  const trimmed = existing.trim();
  if (trimmed.length === 0) return addition;
  return `${trimmed} ${addition}`;
}
