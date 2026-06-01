import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeCodeStatusAdapter, parseUsageLimitReset } from "./claude-code.js";
import type { ObservationContext, SessionAdapterState } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures", "claude-code");

function load(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, `${name}.txt`), "utf8");
}

function ctx(paneCapture: string, over: Partial<ObservationContext> = {}): ObservationContext {
  return {
    paneCapture,
    tmuxActivityChangedSinceLastTick: false,
    ticksSinceActivityChange: 0,
    source: "tick",
    hasObservedSinceBoot: true,
    now: () => new Date("2026-05-26T05:00:00.000Z"),
    ...over,
  };
}

describe("claudeCodeStatusAdapter", () => {
  let state: SessionAdapterState;

  beforeEach(() => {
    state = claudeCodeStatusAdapter.createSessionState();
  });

  describe("fixture coverage", () => {
    it("classifies idle.txt as idle", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("idle")))).toBe("idle");
    });

    it("classifies running-mid-stream.txt as running (esc to interrupt visible)", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("running-mid-stream")))).toBe("running");
    });

    it("classifies running-with-spinner-verb.txt as running", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("running-with-spinner-verb")))).toBe("running");
    });

    it("classifies running-with-monitor.txt as running (bg work suppresses completion)", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("running-with-monitor")))).toBe("running");
    });

    it("classifies running-with-shell.txt as running", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("running-with-shell")))).toBe("running");
    });

    it("classifies running-with-local-agent.txt as running (subagent + esc to interrupt)", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("running-with-local-agent")))).toBe("running");
    });

    it("classifies waiting-for-input-ask-question.txt as waiting_for_input", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("waiting-for-input-ask-question")))).toBe(
        "waiting_for_input",
      );
    });

    it("classifies waiting-for-input-ask-question-tab-arrow.txt as waiting_for_input (new Tab/Arrow nav hint)", () => {
      // Claude Code reworded the AskUserQuestion footer from
      // `↑/↓ to navigate` to `Tab/Arrow keys to navigate`. The detector
      // anchors on the stable `Enter to select` and `Esc to cancel` endpoints.
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("waiting-for-input-ask-question-tab-arrow")))).toBe(
        "waiting_for_input",
      );
    });

    it("classifies waiting-for-input-ask-question-confirm.txt as waiting_for_input (free-text confirm footer)", () => {
      // When the user picks "Type something" / Other in AskUserQuestion, the
      // footer collapses to `Enter to confirm · Esc to cancel` (different verb,
      // no middle nav hint). Detector anchors on `Enter to <verb>` start and
      // `Esc to cancel` end with optional middle segments.
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("waiting-for-input-ask-question-confirm")))).toBe(
        "waiting_for_input",
      );
    });

    it("classifies wakeup-resuming.txt as running (esc to interrupt visible in mid-resume)", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("wakeup-resuming")))).toBe("running");
    });

    it("classifies usage-limited.txt as usage_limited with parsed resetAt in reason", () => {
      // The pane shows `You're out of extra usage · resets 7:50am (UTC)`.
      // With now=05:00 UTC, the next 07:50 UTC is later the same day.
      const result = claudeCodeStatusAdapter.observe(state, ctx(load("usage-limited")));
      expect(result).not.toBeNull();
      if (typeof result === "string" || result === null) throw new Error("expected object result");
      expect(result.observed).toBe("usage_limited");
      expect(result.reason).toBe("pane:usage_limited:reset=2026-05-26T07:50:00.000Z");
    });

    it("usage_limited reset that has already passed surfaces as today's past moment (auto-resume will nudge)", () => {
      // The banner is stale — Claude doesn't auto-refresh once the reset
      // has elapsed. Surfacing the past time lets the auto-resume loop
      // submit a nudge instead of waiting another 24h. The previous
      // "bump to tomorrow" heuristic caused stuck sessions to perpetually
      // postpone (every 2s the adapter parsed the same past time and
      // pushed it forward a day).
      const pane = "⎿  You're out of extra usage · resets 3:15am (UTC)\n  ⏵⏵ auto mode on (shift+tab to cycle)";
      const result = claudeCodeStatusAdapter.observe(state, ctx(pane));
      if (typeof result === "string" || result === null) throw new Error("expected object result");
      expect(result.reason).toBe("pane:usage_limited:reset=2026-05-26T03:15:00.000Z");
    });

    it("usage_limited with unknown timezone falls back to reset=unknown", () => {
      const pane = "⎿  You're out of extra usage · resets 7:50am (PST)\n  ⏵⏵ auto mode on (shift+tab to cycle)";
      const result = claudeCodeStatusAdapter.observe(state, ctx(pane));
      if (typeof result === "string" || result === null) throw new Error("expected object result");
      expect(result.reason).toBe("pane:usage_limited:reset=unknown");
    });

    it("classifies rate-limited-server.txt as rate_limited (server rate-limit error visible, idle mode line)", () => {
      // The agent printed `API Error: Server is temporarily limiting requests
      // (not your usage limit) · Rate limited` as a tool-result block, then
      // stalled — mode line is back to the bare idle baseline with no
      // `esc to interrupt`. Without this rule we'd report `idle` and silently
      // hide the stall from the operator.
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("rate-limited-server")))).toBe("rate_limited");
    });

    it("when both limit banners are visible, the more recent (lower-in-pane) wins — rate_limited", () => {
      // A session that bounced: earlier nudge got the account-cap banner,
      // most recent nudge got the server rate-limit banner. The agent's
      // CURRENT state is the server rate-limit, so we want backoff retries
      // (rate_limited) not the postpone-until-reset path (usage_limited).
      const pane = [
        "⎿  You're out of extra usage · resets 7:50am (UTC)",
        "   /extra-usage to finish what you're working on.",
        "✻ Cogitated for 0s",
        "❯ continue, please",
        "  Ran 2 shell commands",
        "  ⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
        "✻ Worked for 23s",
        "  ⏵⏵ auto mode on (shift+tab to cycle)",
      ].join("\n");
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("rate_limited");
    });

    it("when both limit banners are visible, the more recent (lower-in-pane) wins — usage_limited", () => {
      // Reversed order: server rate-limit was the earlier failure; account
      // cap is the most recent. Current state is usage_limited, gate engages.
      const pane = [
        "⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited",
        "✻ Crunched for 24s",
        "❯ continue, please",
        "  ⎿  You're out of extra usage · resets 7:50am (UTC)",
        "     /extra-usage to finish what you're working on.",
        "  ⏵⏵ auto mode on (shift+tab to cycle)",
      ].join("\n");
      const result = claudeCodeStatusAdapter.observe(state, ctx(pane));
      if (typeof result === "string" || result === null) throw new Error("expected object result");
      expect(result.observed).toBe("usage_limited");
      expect(result.reason).toBe("pane:usage_limited:reset=2026-05-26T07:50:00.000Z");
    });

    it("active turn beats a stale rate-limit message (esc to interrupt re-armed during retry)", () => {
      // If Claude Code's internal retry succeeded, the mode line re-arms with
      // `esc to interrupt` while the rate-limit text still scrolls above.
      // Active-turn priority must win over rate_limited so the dot returns
      // to running.
      const pane =
        "⎿  API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited\n" +
        "✻ Brewing… (esc to interrupt)\n" +
        "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("running");
    });

    it("classifies idle-with-tasks-visible.txt as idle (Ctrl+C with task panel still on screen)", () => {
      // Real capture from a session where the user pressed Ctrl+C while a
      // TodoWrite task panel was visible. Mode line is
      // `⏵⏵ auto mode on (shift+tab to cycle) · ctrl+t to hide tasks` with
      // no `esc to interrupt`. Previously fell through to `return null`,
      // leaving the session stuck in `running` indefinitely.
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("idle-with-tasks-visible")))).toBe("idle");
    });
  });

  describe("false-positive guard — chrome strings in agent body don't trigger", () => {
    it("classifies false-positive-prompt-text.txt as idle (chrome strings in body, mode line is bare idle)", () => {
      // The fixture has the agent describing ALL four chrome strings in its
      // response body, but the bottom mode line is the bare idle baseline.
      // Anchoring to lastNonEmptyLine rejects the false positives.
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("false-positive-prompt-text")))).toBe("idle");
    });
  });

  describe("synthetic edge cases", () => {
    it("empty pane → null", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(""))).toBeNull();
    });

    it("only whitespace lines → null", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx("\n\n\n   \n\n"))).toBeNull();
    });

    it("garbage bottom line → null (no opinion)", () => {
      expect(
        claudeCodeStatusAdapter.observe(state, ctx("some\nrandom\ntext\nthat doesn't match any chrome pattern")),
      ).toBeNull();
    });

    it("elapsed timer advancement is a first-pass running signal without the mode-line marker", () => {
      const paneAt10s = "output\n· Pondering… (10s · ↓ 281 tokens)\nfooter without known chrome";
      const paneAt12s = "output\n· Pondering… (12s · ↓ 312 tokens)\nfooter without known chrome";
      expect(claudeCodeStatusAdapter.observe(state, ctx(paneAt10s))).toBeNull();
      expect(claudeCodeStatusAdapter.observe(state, ctx(paneAt12s))).toMatchObject({ observed: "running" });
    });

    it("old active timer text does not override an idle mode line unless the timer advances", () => {
      const pane = "· Pondering… (10s · ↓ 281 tokens)\n  ⏵⏵ auto mode on (shift+tab to cycle)";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("idle");
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("idle");
    });

    it("matches local-agent suffix without esc to interrupt (subagent waiting)", () => {
      const pane = "agent output\n  ⏵⏵ auto mode on · 2 local agent · ↓ to manage";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("running");
    });

    it("matches monitor suffix without esc to interrupt", () => {
      const pane = "x\n  ⏵⏵ auto mode on · 1 monitor · ↓ to manage";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("running");
    });

    it("matches multi-digit background counts", () => {
      const pane = "x\n  ⏵⏵ auto mode on · 12 shell · ↓ to manage";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("running");
    });

    it("matches pluralized background work (`· 2 shells · ↓ to manage`)", () => {
      // Claude-code pluralizes the noun once the count crosses 1. Before the
      // s? fix, `2 shells` fell through to null and the dot only stayed
      // running by virtue of the reducer holding the prior status.
      const pane = "x\n  ⏵⏵ auto mode on · 2 shells · ↓ to manage";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("running");
    });

    it("matches pluralized monitors and local agents too", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx("x\n  ⏵⏵ auto mode on · 3 monitors · ↓ to manage"))).toBe(
        "running",
      );
      expect(claudeCodeStatusAdapter.observe(state, ctx("x\n  ⏵⏵ auto mode on · 2 local agents · ↓ to manage"))).toBe(
        "running",
      );
    });

    it("treats `<idle prefix> · ctrl+t to hide tasks` as idle (post-interrupt with task panel)", () => {
      const pane = "x\n  ⏵⏵ auto mode on (shift+tab to cycle) · ctrl+t to hide tasks";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("idle");
    });

    it("treats `<idle prefix> · <unknown suffix>` (no esc to interrupt, no bg work) as idle", () => {
      // Forward-compat: any future post-turn chrome hint that hangs off the
      // idle prefix should still classify as idle, since priorities 2/3
      // already ruled out the active and background-work cases.
      const pane = "x\n  ⏵⏵ auto mode on (shift+tab to cycle) · some future hint";
      expect(claudeCodeStatusAdapter.observe(state, ctx(pane))).toBe("idle");
    });
  });

  describe("parseUsageLimitReset", () => {
    const now = new Date("2026-05-26T05:00:00.000Z");

    it("parses 'resets 7:50am (UTC)' to today's 07:50 UTC", () => {
      expect(parseUsageLimitReset("You're out of extra usage · resets 7:50am (UTC)", now)).toBe(
        "2026-05-26T07:50:00.000Z",
      );
    });

    it("parses 'resets 11:30pm (UTC)' to 23:30 UTC", () => {
      expect(parseUsageLimitReset("resets 11:30pm (UTC)", now)).toBe("2026-05-26T23:30:00.000Z");
    });

    it("parses '12:00am (UTC)' to midnight (hour=0); past times surface as-is for the auto-resume loop", () => {
      expect(parseUsageLimitReset("resets 12:00am (UTC)", now)).toBe("2026-05-26T00:00:00.000Z");
    });

    it("returns null for non-UTC timezone (we'd risk DST drift)", () => {
      expect(parseUsageLimitReset("resets 7:50am (PST)", now)).toBeNull();
    });

    it("returns null when the line doesn't contain a reset clause", () => {
      expect(parseUsageLimitReset("You're out of extra usage", now)).toBeNull();
    });
  });

  describe("ticksObserved counter", () => {
    it("increments on every observe call", () => {
      claudeCodeStatusAdapter.observe(state, ctx(load("idle")));
      claudeCodeStatusAdapter.observe(state, ctx(load("running-mid-stream")));
      expect(state.ticksObserved).toBe(2);
    });
  });
});
