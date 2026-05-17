export function formatLabel(value: string) {
  const acronyms = new Set(["ci", "mcp", "pr"]);
  return value
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part, index) => {
      const lower = part.toLowerCase();
      if (acronyms.has(lower)) return lower.toUpperCase();
      return index === 0 ? `${lower[0]?.toUpperCase() ?? ""}${lower.slice(1)}` : lower;
    })
    .join(" ");
}
