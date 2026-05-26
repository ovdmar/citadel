import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { claudeCodeStatusAdapter } from "./claude-code.js";
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

  describe("ticksObserved counter", () => {
    it("increments on every observe call", () => {
      claudeCodeStatusAdapter.observe(state, ctx(load("idle")));
      claudeCodeStatusAdapter.observe(state, ctx(load("running-mid-stream")));
      expect(state.ticksObserved).toBe(2);
    });
  });
});
