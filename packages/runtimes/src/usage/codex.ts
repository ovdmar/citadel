import type { RuntimeUsageCategory } from "@citadel/contracts";
import { sleep, spawnEphemeralTmux, stripAnsi } from "./tmux-pty.js";

const READY_MARKER = "OpenAI Codex";
const PANEL_OPEN = "╭";
const PANEL_CLOSE = "╰";

// "│  5h limit:                    [████████████████████] 100% left (resets 10:00)           │"
// "│  Weekly limit:                [██░░░░░░░░░░░░░░░░░░]  10% left (resets 21:32 on 30 May) │"
const LIMIT_RE =
  /^\s*\|?\s*│?\s*(?<label>[^│|:]+?)\s*:\s*(?:\[[^\]]*\]\s*)?(?<pct>\d{1,3})\s*%\s*left\s*\(\s*resets?\s+(?<reset>[^)]+?)\s*\)\s*│?\s*$/i;
// "│  GPT-5.3-Codex-Spark limit:                                                             │"
const SECTION_HEADER_RE = /^\s*│\s*(?<label>[^│:]+?)\s*:\s*│\s*$/i;

// Return the LAST box (between ╭ … ╰) that contains "OpenAI Codex (v…)".
// The initial welcome banner also has that string; the /status panel is the
// later, larger box, so we take the last match.
export function extractCodexStatusPanel(rawPaneText: string): string[] {
  const lines = rawPaneText.split("\n").map((line) => stripAnsi(line).replace(/\s+$/, ""));
  const matches: string[][] = [];
  let panel: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && line.trimStart().startsWith(PANEL_OPEN)) {
      panel = [line];
      inside = true;
      continue;
    }
    if (inside) {
      panel.push(line);
      if (line.trimStart().startsWith(PANEL_CLOSE)) {
        if (panel.some((entry) => entry.includes("OpenAI Codex (v"))) matches.push(panel);
        panel = [];
        inside = false;
      }
    }
  }
  return matches[matches.length - 1] ?? [];
}

// Parse rate-limit rows. Section headers (label-only rows like
// "GPT-5.3-Codex-Spark limit:") qualify the rows that follow until the next
// section header.
export function parseCodexUsageCategories(panelLines: string[]): RuntimeUsageCategory[] {
  const results: RuntimeUsageCategory[] = [];
  let section: string | null = null;
  for (const line of panelLines) {
    const match = line.match(LIMIT_RE);
    if (match?.groups) {
      const label = match.groups.label?.trim() ?? "";
      const pctLeft = Number.parseInt(match.groups.pct ?? "", 10);
      const reset = match.groups.reset?.trim() ?? null;
      if (!label || !Number.isFinite(pctLeft) || pctLeft < 0 || pctLeft > 100) continue;
      // codex reports "% left" — normalize to "% used" so both providers expose
      // the same number to the UI.
      const percentUsed = 100 - pctLeft;
      results.push({ label, percentUsed, reset, section });
      continue;
    }
    const headerMatch = line.match(SECTION_HEADER_RE);
    if (headerMatch?.groups) {
      const candidate = headerMatch.groups.label?.trim() ?? "";
      if (
        candidate.toLowerCase().includes("limit") &&
        !["5h limit", "weekly limit"].includes(candidate.toLowerCase())
      ) {
        section = candidate;
      }
    }
  }
  return results;
}

// Drive `codex` via tmux to render /status, parse the rate-limit rows.
//
// GOTCHA the PoC uncovered: codex's TUI requires the slash command text and
// Enter to be sent as SEPARATE send-keys calls — otherwise both land inside
// the input box without submitting. We do `sendText` then `sleep(500)` then
// `sendKey("Enter")`.
export async function fetchCodexUsageCategories(input: {
  command: string;
  args?: string[];
}): Promise<RuntimeUsageCategory[]> {
  const tmux = await spawnEphemeralTmux({
    command: input.command,
    args: input.args ?? [],
    width: 220,
    height: 80,
    scrollback: 500,
    sessionPrefix: "citadel_usage_codex",
  });
  try {
    await tmux.waitFor((text) => text.includes(READY_MARKER), { timeoutMs: 40_000 });
    tmux.sendText("/status");
    await sleep(500);
    tmux.sendKey("Enter");
    await tmux.waitFor((text) => text.includes("5h limit") || text.includes("Weekly limit"), {
      timeoutMs: 15_000,
      intervalMs: 300,
    });
    await sleep(1_000);
    const panel = extractCodexStatusPanel(tmux.capture());
    return parseCodexUsageCategories(panel);
  } finally {
    tmux.kill();
  }
}
