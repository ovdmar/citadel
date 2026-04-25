export function isoNow() {
  return new Date().toISOString();
}

export function toTitleCase(input: string) {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

export function trimExcerpt(text: string | undefined, max = 280) {
  if (!text) return undefined;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

export function minutesSince(input?: string) {
  if (!input) return Number.POSITIVE_INFINITY;
  const ms = Date.now() - new Date(input).getTime();
  return ms / 1000 / 60;
}
