import { describe, expect, it } from "vitest";
import { extractClaudeUsagePanel, parseClaudeUsageCategories } from "./claude-code.js";
import { extractCodexStatusPanel, parseCodexUsageCategories } from "./codex.js";

// Golden input lifted from the PoC documentation (see
// /home/jonsnow/citadel-share/usage-poc/*.py). These are the live shapes of
// the panels the runtimes paint into the pane — keep in lockstep with the PoC.

const CLAUDE_PANEL = `
 Status   Config   Usage   Stats

  Current session
  ████                                               11% used
  Resets 10:10am (UTC)

  Current week (all models)
  █████████                                          18% used
  Resets May 27, 12pm (UTC)

  Current week (Sonnet only)
  ▌                                                   1% used
  Resets May 27, 12pm (UTC)

  Esc to cancel
`;

const CODEX_PANEL = `
  Some unrelated welcome text
╭─ OpenAI Codex (v1.2.3) ───────────────────────────────────╮
│  Welcome banner stuff                                     │
╰───────────────────────────────────────────────────────────╯

╭─────────────────────────── OpenAI Codex (v1.2.3) ────────────────────────────╮
│  GPT-5.3-Codex limit:                                                        │
│  5h limit:                    [████████████████████] 100% left (resets 10:00)│
│  Weekly limit:                [████████████████████] 100% left (resets 21:32 on 30 May)│
│  GPT-5.3-Codex-Spark limit:                                                  │
│  5h limit:                    [████████████████████] 100% left (resets 11:47)│
│  Weekly limit:                [██░░░░░░░░░░░░░░░░░░]  10% left (resets 06:47 on 31 May)│
╰──────────────────────────────────────────────────────────────────────────────╯
`;

describe("claude-code usage parser", () => {
  it("extracts the panel body between the tab strip and the footer", () => {
    const panel = extractClaudeUsagePanel(CLAUDE_PANEL);
    expect(panel.length).toBeGreaterThan(0);
    expect(panel[0]).toContain("Current session");
    expect(panel.some((line) => line.includes("Esc to cancel"))).toBe(false);
  });

  it("parses three categories with labels, percentUsed, and reset strings", () => {
    const panel = extractClaudeUsagePanel(CLAUDE_PANEL);
    const categories = parseClaudeUsageCategories(panel);
    expect(categories).toHaveLength(3);
    expect(categories[0]).toEqual({
      label: "Current session",
      percentUsed: 11,
      reset: "10:10am (UTC)",
      section: null,
    });
    expect(categories[1]).toMatchObject({ label: "Current week (all models)", percentUsed: 18 });
    expect(categories[2]).toMatchObject({ label: "Current week (Sonnet only)", percentUsed: 1 });
  });

  it("returns an empty list when the panel is not present", () => {
    expect(parseClaudeUsageCategories(extractClaudeUsagePanel("just a shell prompt\n$ "))).toEqual([]);
  });
});

describe("codex usage parser", () => {
  it("returns the LAST OpenAI Codex box, not the welcome banner", () => {
    const panel = extractCodexStatusPanel(CODEX_PANEL);
    expect(panel.some((line) => line.includes("5h limit"))).toBe(true);
    expect(panel.some((line) => line.includes("Welcome banner stuff"))).toBe(false);
  });

  it("normalizes % left → % used and attaches section headers", () => {
    const panel = extractCodexStatusPanel(CODEX_PANEL);
    const categories = parseCodexUsageCategories(panel);
    expect(categories).toHaveLength(4);
    expect(categories[0]).toEqual({
      label: "5h limit",
      percentUsed: 0,
      reset: "10:00",
      section: "GPT-5.3-Codex limit",
    });
    expect(categories[1]).toMatchObject({
      label: "Weekly limit",
      percentUsed: 0,
      reset: "21:32 on 30 May",
      section: "GPT-5.3-Codex limit",
    });
    expect(categories[2]?.section).toBe("GPT-5.3-Codex-Spark limit");
    expect(categories[3]).toMatchObject({
      label: "Weekly limit",
      // 10% left → 90% used
      percentUsed: 90,
      section: "GPT-5.3-Codex-Spark limit",
    });
  });

  it("returns an empty list when no Codex box is present", () => {
    expect(parseCodexUsageCategories(extractCodexStatusPanel("hello world\n"))).toEqual([]);
  });
});
