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

    it("classifies wakeup-resuming.txt as running (esc to interrupt visible in mid-resume)", () => {
      expect(claudeCodeStatusAdapter.observe(state, ctx(load("wakeup-resuming")))).toBe("running");
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
  });

  describe("ticksObserved counter", () => {
    it("increments on every observe call", () => {
      claudeCodeStatusAdapter.observe(state, ctx(load("idle")));
      claudeCodeStatusAdapter.observe(state, ctx(load("running-mid-stream")));
      expect(state.ticksObserved).toBe(2);
    });
  });
});
