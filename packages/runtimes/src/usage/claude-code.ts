import type { RuntimeUsageCategory } from "@citadel/contracts";
import { sleep, spawnEphemeralTmux, stripAnsi } from "./tmux-pty.js";

const READY_MARKER = "Claude Code v";
const PERCENT_RE = /(\d{1,3})\s*%\s*used/i;
const RESETS_LINE_RE = /^\s*Resets?\s+(.+?)\s*$/i;
const BAR_ONLY_RE = /^[\s█▉▊▋▌▍▎▏░▒▓▀▄▐▆▅▃▂▁.·…]+$/;

// Extract the body of the /usage panel: the lines following the "Status …
// Usage … Stats" tab strip, up to the bottom hint row.
export function extractClaudeUsagePanel(rawPaneText: string): string[] {
  const lines = rawPaneText.split("\n").map((line) => stripAnsi(line).replace(/\s+$/, ""));
  let start: number | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.includes("Status") && line.includes("Usage") && line.includes("Stats")) {
      start = i + 1;
      break;
    }
  }
  if (start === null) return [];
  let end = lines.length;
  for (let j = start; j < lines.length; j += 1) {
    const stripped = (lines[j] ?? "").trim().toLowerCase();
    if (stripped.startsWith("esc to cancel") || stripped.startsWith("←/→") || stripped.startsWith("↓")) {
      end = j;
      break;
    }
  }
  return lines.slice(start, end).filter((line) => line.trim().length > 0);
}

// Parse (label, percentUsed, reset) triples out of the panel body.
// The format is three blocks of (label / bar+percent / "Resets …").
export function parseClaudeUsageCategories(panelLines: string[]): RuntimeUsageCategory[] {
  const results: RuntimeUsageCategory[] = [];
  for (let i = 0; i < panelLines.length; i += 1) {
    const line = panelLines[i] ?? "";
    const match = line.match(PERCENT_RE);
    if (!match) continue;
    const pct = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) continue;

    // Walk backwards up to 5 non-empty lines to find the label.
    let label: string | null = null;
    for (let k = i - 1; k >= Math.max(0, i - 6); k -= 1) {
      const cand = (panelLines[k] ?? "").trim();
      if (!cand) continue;
      if (RESETS_LINE_RE.test(cand)) continue;
      if (BAR_ONLY_RE.test(cand)) continue;
      label = cand;
      break;
    }

    // Walk forward for the "Resets …" line.
    let reset: string | null = null;
    for (let k = i + 1; k < Math.min(panelLines.length, i + 5); k += 1) {
      const cand = (panelLines[k] ?? "").trim();
      if (!cand) continue;
      const rm = cand.match(RESETS_LINE_RE);
      if (rm?.[1]) reset = rm[1].trim();
      break;
    }

    if (label) results.push({ label, percentUsed: pct, reset, section: null });
  }
  return results;
}

// Drive `claude` via tmux to render /usage, capture the panel, return parsed
// categories. The PoC (see /home/jonsnow/citadel-share/usage-poc/claude_usage.py)
// is the authoritative reference for the interaction pattern.
//
// Critical detail: launch `claude` with NO FLAGS. `--bare` forces
// ANTHROPIC_API_KEY mode and the 3-category Max-subscription panel vanishes.
export async function fetchClaudeUsageCategories(input: {
  command: string;
  args?: string[];
}): Promise<RuntimeUsageCategory[]> {
  const tmux = await spawnEphemeralTmux({
    command: input.command,
    args: input.args ?? [],
    width: 200,
    height: 60,
    scrollback: 300,
    sessionPrefix: "citadel_usage_claude",
  });
  try {
    const banner = await tmux.waitFor((text) => text.includes(READY_MARKER), { timeoutMs: 40_000 });
    if (!banner.includes(READY_MARKER)) {
      throw new Error("claude-code did not produce welcome banner in time");
    }
    // claude-code accepts the slash command + Enter in a single send-keys.
    tmux.sendText("/usage");
    tmux.sendKey("Enter");
    // /usage doesn't paint instantly; the PoC sleeps 2s. We poll for the tab
    // strip too so we don't waste time when it paints quickly.
    await tmux.waitFor((text) => text.includes("Status") && text.includes("Usage") && text.includes("Stats"), {
      timeoutMs: 15_000,
      intervalMs: 250,
    });
    await sleep(500);
    const panel = extractClaudeUsagePanel(tmux.capture());
    return parseClaudeUsageCategories(panel);
  } finally {
    tmux.kill();
  }
}
