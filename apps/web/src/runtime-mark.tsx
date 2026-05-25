// Inline brand monograms for the runtimes Citadel surfaces in the cockpit.
// These are stylized recognizable shapes, not the providers' official marks —
// good enough for a low-contrast chrome pill, no asset licensing to manage.
export function RuntimeMark({ runtimeId, size = 14 }: { runtimeId: string; size?: number }) {
  switch (runtimeId) {
    case "claude-code":
      return <ClaudeMark size={size} />;
    case "codex":
      return <CodexMark size={size} />;
    default:
      return <GenericMark runtimeId={runtimeId} size={size} />;
  }
}

// Anthropic uses an 8-point starburst; this is an inspired geometric monogram
// that reads as "Claude" without being a literal copy of their wordmark.
function ClaudeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <title>Claude Code</title>
      <path
        d="M12 2.5 L13.6 9 L20 7.6 L15 12 L20 16.4 L13.6 15 L12 21.5 L10.4 15 L4 16.4 L9 12 L4 7.6 L10.4 9 Z"
        fill="currentColor"
      />
    </svg>
  );
}

// Codex/OpenAI visual language leans on knot/ring motifs; a simple thick ring
// reads cleanly at 14–16 px and matches the cockpit's minimalist chrome.
function CodexMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <title>Codex</title>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <circle cx="12" cy="12" r="2.4" fill="currentColor" />
    </svg>
  );
}

// Fallback monogram for custom runtimes — first letter in a rounded square so
// the pill still has a visual anchor when no brand mark exists.
function GenericMark({ runtimeId, size }: { runtimeId: string; size: number }) {
  const letter = runtimeId.slice(0, 1).toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <title>{runtimeId}</title>
      <rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor" opacity="0.18" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fontSize="13"
        fontFamily="ui-monospace, monospace"
        fontWeight="600"
        fill="currentColor"
      >
        {letter}
      </text>
    </svg>
  );
}
