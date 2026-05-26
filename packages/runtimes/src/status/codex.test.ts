import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { codexStatusAdapter } from "./codex.js";
import type { ObservationContext, SessionAdapterState } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "..", "fixtures", "codex");

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

describe("codexStatusAdapter", () => {
  let state: SessionAdapterState;

  beforeEach(() => {
    state = codexStatusAdapter.createSessionState();
  });

  describe("fixture coverage", () => {
    it("classifies waiting-for-input-sandbox.txt as waiting_for_input", () => {
      expect(codexStatusAdapter.observe(state, ctx(load("waiting-for-input-sandbox")))).toBe("waiting_for_input");
    });

    it("classifies idle.txt as idle when ≥2 stable ticks and observed", () => {
      const pane = load("idle");
      expect(
        codexStatusAdapter.observe(
          state,
          ctx(pane, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 2 }),
        ),
      ).toBe("idle");
    });

    it("classifies running-mid-stream.txt as running when activity recent", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx(load("running-mid-stream"), { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 }),
        ),
      ).toBe("running");
    });

    it("classifies running-spinner.txt as running on the spinner alone (no recent tmux activity)", () => {
      // Real capture from a codex session computing for minutes without
      // visibly redrawing — the `◦ Working (2m 36s • esc to interrupt)` line
      // is the only positive signal. Previously misclassified as idle once
      // the activity timestamp went stale.
      expect(
        codexStatusAdapter.observe(
          state,
          ctx(load("running-spinner"), { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 5 }),
        ),
      ).toBe("running");
    });
  });

  describe("active spinner detection", () => {
    it("'• Working (1m 52s • esc to interrupt)' → running", () => {
      const pane = "some output\n• Working (1m 52s • esc to interrupt)\n\n  gpt-5.5 default · ~/wherever";
      expect(
        codexStatusAdapter.observe(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true })),
      ).toBe("running");
    });

    it("'◦ Thinking (12s • esc to interrupt)' (animated bullet variant) → running", () => {
      const pane = "x\n◦ Thinking (12s • esc to interrupt)\n  gpt-5.5 default · ~/wherever";
      expect(
        codexStatusAdapter.observe(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true })),
      ).toBe("running");
    });

    it("sandbox footer 'esc to cancel' (no closing paren) does NOT trigger running", () => {
      const pane = "x\nPress enter to confirm or esc to cancel";
      expect(
        codexStatusAdapter.observe(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true })),
      ).toBe("waiting_for_input");
    });
  });

  describe("activity timestamp drives running/idle", () => {
    it("tmuxActivityChangedSinceLastTick → running regardless of stability", () => {
      expect(
        codexStatusAdapter.observe(state, ctx("some pane content", { tmuxActivityChangedSinceLastTick: true })),
      ).toBe("running");
    });

    it("stability of exactly 1 tick → null (not yet enough to call idle)", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 1 }),
        ),
      ).toBeNull();
    });

    it("stability of 2 ticks → idle", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 2 }),
        ),
      ).toBe("idle");
    });

    it("stability of 5 ticks → idle (still)", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 5 }),
        ),
      ).toBe("idle");
    });
  });

  describe("boot suppression — first post-boot tick MUST NOT emit idle", () => {
    it("source=boot with 2 stable ticks → null (don't classify yet)", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { source: "boot", ticksSinceActivityChange: 2, hasObservedSinceBoot: false }),
        ),
      ).toBeNull();
    });

    it("source=tick but hasObservedSinceBoot=false (cold start) → null even with stability", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { source: "tick", ticksSinceActivityChange: 2, hasObservedSinceBoot: false }),
        ),
      ).toBeNull();
    });

    it("source=tick with hasObservedSinceBoot=true and stability → idle", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx("some pane content", { source: "tick", ticksSinceActivityChange: 2, hasObservedSinceBoot: true }),
        ),
      ).toBe("idle");
    });

    it("source=boot but waiting_for_input footer still applies (sandbox approval is sticky)", () => {
      const pane = "something\nPress enter to confirm or esc to cancel";
      expect(codexStatusAdapter.observe(state, ctx(pane, { source: "boot", hasObservedSinceBoot: false }))).toBe(
        "waiting_for_input",
      );
    });
  });

  describe("false-positive guard", () => {
    it("classifies false-positive-prompt-text.txt as idle (chrome strings only in body)", () => {
      expect(
        codexStatusAdapter.observe(
          state,
          ctx(load("false-positive-prompt-text"), { ticksSinceActivityChange: 2, hasObservedSinceBoot: true }),
        ),
      ).toBe("idle");
    });
  });

  describe("ticksObserved counter", () => {
    it("increments on every observe call", () => {
      codexStatusAdapter.observe(state, ctx(""));
      codexStatusAdapter.observe(state, ctx(""));
      expect(state.ticksObserved).toBe(2);
    });
  });
});
