export function renderScratchpadStatus(updatedAt: string | null, pulse: "ok" | "err" | null) {
  if (pulse === "ok") return "Saved ✓";
  if (pulse === "err") return "Save failed";
  if (!updatedAt) return "";
  const stamp = new Date(updatedAt);
  return Number.isNaN(stamp.getTime()) ? "Saved" : `Saved · ${stamp.toLocaleTimeString()}`;
}

export function formatScratchpadHistoryStamp(ts: string) {
  const stamp = new Date(ts);
  if (Number.isNaN(stamp.getTime())) return ts;
  return stamp.toLocaleString();
}
