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

function observeStatus(state: SessionAdapterState, context: ObservationContext) {
  const observed = codexStatusAdapter.observe(state, context);
  if (observed === null || typeof observed === "string") return observed;
  return observed.observed;
}

describe("codexStatusAdapter", () => {
  let state: SessionAdapterState;

  beforeEach(() => {
    state = codexStatusAdapter.createSessionState();
  });

  describe("fixture coverage", () => {
    it("classifies waiting-for-input-sandbox.txt as waiting_for_input", () => {
      expect(observeStatus(state, ctx(load("waiting-for-input-sandbox")))).toBe("waiting_for_input");
    });

    it("classifies idle.txt as idle when ≥2 stable ticks and observed", () => {
      const pane = load("idle");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 2 })),
      ).toBe("idle");
    });

    it("classifies running-mid-stream.txt as running when current turn output changes", () => {
      observeStatus(state, ctx(load("idle"), { ticksSinceActivityChange: 2 }));
      expect(
        observeStatus(
          state,
          ctx(load("running-mid-stream"), { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 }),
        ),
      ).toBe("running");
    });

    it("classifies idle-post-turn-divider.txt as idle immediately on the divider (no null window)", () => {
      // After the spinner disappears, codex prints `─ Worked for Xm Ys ───`.
      // Previously the adapter returned null until ticksSinceActivityChange ≥ 2,
      // which left the UI flickering through running before settling on idle.
      // Detector now treats the divider as a positive idle signal.
      expect(
        observeStatus(
          state,
          ctx(load("idle-post-turn-divider"), { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 0 }),
        ),
      ).toBe("idle");
    });

    it("classifies running-spinner.txt as running on the spinner alone (no recent tmux activity)", () => {
      // Real capture from a codex session computing for minutes without
      // visibly redrawing — the `◦ Working (2m 36s • esc to interrupt)` line
      // is the only positive signal. Previously misclassified as idle once
      // the activity timestamp went stale.
      expect(
        observeStatus(
          state,
          ctx(load("running-spinner"), { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 5 }),
        ),
      ).toBe("running");
    });
  });

  describe("active interrupt marker detection", () => {
    it("'• Working (1m 52s • esc to interrupt)' → running", () => {
      const pane = "some output\n• Working (1m 52s • esc to interrupt)\n\n  gpt-5.5 default · ~/wherever";
      expect(observeStatus(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true }))).toBe(
        "running",
      );
    });

    it("'◦ Thinking (12s • esc to interrupt)' (animated bullet variant) → running", () => {
      const pane = "x\n◦ Thinking (12s • esc to interrupt)\n  gpt-5.5 default · ~/wherever";
      expect(observeStatus(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true }))).toBe(
        "running",
      );
    });

    it("'esc for interrupt' wording variant → running", () => {
      const pane = "x\n◦ Thinking (12s • esc for interrupt)\n  gpt-5.5 default · ~/wherever";
      expect(observeStatus(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true }))).toBe(
        "running",
      );
    });

    it("interrupt marker beats a visible post-turn divider and stable-idle fallback", () => {
      const pane = [
        "agent output",
        "─ Worked for 1m 12s ──────────────────────",
        "",
        "◦ Working (18s • esc for interrupt)",
        "",
        "  gpt-5.5 default · ~/wherever",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 10 })),
      ).toBe("running");
    });

    it("interrupt marker beats the sandbox footer if both are visible", () => {
      const pane = "◦ Working (18s • esc for interrupt)\nPress enter to confirm or esc to cancel";
      expect(observeStatus(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true }))).toBe(
        "running",
      );
    });

    it("post-turn divider beats stale tmux activity (running → idle is immediate)", () => {
      const pane = "agent output\n─ Worked for 1m 12s ──────────────────────";
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBe("idle");
    });

    it("new assistant output after an old post-turn divider reports running", () => {
      observeStatus(state, ctx(load("idle"), { ticksSinceActivityChange: 2 }));
      const pane = [
        "previous output",
        "─ Worked for 1m 12s ──────────────────────",
        "",
        "› Start another task.",
        "",
        "• I am beginning the task, but the spinner has not rendered in this capture.",
        "",
        "› Use /skills to list available skills",
        "  gpt-5.5 default · ~/wherever",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBe("running");
    });

    it("typed prompt after an old post-turn divider does not report running before assistant output", () => {
      observeStatus(state, ctx(load("idle"), { ticksSinceActivityChange: 2 }));
      const pane = [
        "previous output",
        "─ Worked for 1m 12s ──────────────────────",
        "",
        "› Start another task.",
        "",
        "› Use /skills to list available skills",
        "  gpt-5.5 default · ~/wherever",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBeNull();
    });

    it("current-turn post divider after the latest prompt still reports idle immediately", () => {
      const pane = [
        "› Start another task.",
        "",
        "• Done.",
        "",
        "─ Worked for 5s ──────────────────────",
        "",
        "› Use /skills to list available skills",
        "  gpt-5.5 default · ~/wherever",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBe("idle");
    });

    it("body line mentioning 'worked for' (no leading divider glyph) does NOT trigger idle", () => {
      const pane = "I worked for 3 hours on this\n";
      expect(
        observeStatus(
          state,
          ctx(pane, {
            tmuxActivityChangedSinceLastTick: false,
            ticksSinceActivityChange: 2,
            hasObservedSinceBoot: true,
          }),
        ),
      ).toBe("idle"); // falls through to stability-based idle, not via the divider rule
    });

    it("sandbox footer 'esc to cancel' (no closing paren) does NOT trigger running", () => {
      const pane = "x\nPress enter to confirm or esc to cancel";
      expect(observeStatus(state, ctx(pane, { ticksSinceActivityChange: 10, hasObservedSinceBoot: true }))).toBe(
        "waiting_for_input",
      );
    });
  });

  describe("activity timestamp drives running/idle", () => {
    it("elapsed timer advancement is a first-pass running signal without tmux activity", () => {
      const paneAt10s = "some output\n◦ Working (10s)\n  gpt-5.5 default · ~/wherever";
      const paneAt12s = "some output\n• Working (12s)\n  gpt-5.5 default · ~/wherever";
      expect(
        observeStatus(state, ctx(paneAt10s, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 10 })),
      ).toBeNull();
      expect(
        observeStatus(state, ctx(paneAt12s, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 10 })),
      ).toBe("running");
    });

    it("a visible active timer suppresses stable-timeout idle until a later tick proves it is stale", () => {
      const pane = "some output\n◦ Working (2m 36s)\n  gpt-5.5 default · ~/wherever";
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 10 })),
      ).toBeNull();
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 10 })),
      ).toBe("idle");
    });

    it("tmux activity alone is not a running signal", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 }),
        ),
      ).toBeNull();
    });

    it("typed prompt after a completed turn stays idle, even with fresh pane activity", () => {
      const pane = [
        "Implemented the status detection change.",
        "",
        "─ Worked for 13m 12s ──────────────────────",
        "",
        "",
        "› Find and fix a bug in @filename",
        "",
        "  gpt-5.5 xhigh · ~/Workspace/citadel",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBeNull();
    });

    it("answer text mentioning esc to interrupt after a completed turn does not report running", () => {
      const pane = [
        "• You’re right. I fixed it so Codex no longer treats tmux activity as running.",
        "",
        "  It now reports running only from positive runtime signals: advancing active timer or esc to interrupt.",
        "",
        "─ Worked for 2m 50s ──────────────────────",
        "",
        "",
        "› Find and fix a bug in @filename",
        "",
        "  gpt-5.5 xhigh · ~/Workspace/citadel",
      ].join("\n");
      expect(
        observeStatus(state, ctx(pane, { tmuxActivityChangedSinceLastTick: true, ticksSinceActivityChange: 0 })),
      ).toBeNull();
    });

    it("stability of exactly 1 tick → null (not yet enough to call idle)", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 1 }),
        ),
      ).toBeNull();
    });

    it("stability of 2 ticks → idle", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 2 }),
        ),
      ).toBe("idle");
    });

    it("stability of 5 ticks → idle (still)", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { tmuxActivityChangedSinceLastTick: false, ticksSinceActivityChange: 5 }),
        ),
      ).toBe("idle");
    });
  });

  describe("boot suppression — first post-boot tick MUST NOT emit idle", () => {
    it("source=boot with 2 stable ticks → null (don't classify yet)", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { source: "boot", ticksSinceActivityChange: 2, hasObservedSinceBoot: false }),
        ),
      ).toBeNull();
    });

    it("source=tick but hasObservedSinceBoot=false (cold start) → null even with stability", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { source: "tick", ticksSinceActivityChange: 2, hasObservedSinceBoot: false }),
        ),
      ).toBeNull();
    });

    it("source=tick with hasObservedSinceBoot=true and stability → idle", () => {
      expect(
        observeStatus(
          state,
          ctx("some pane content", { source: "tick", ticksSinceActivityChange: 2, hasObservedSinceBoot: true }),
        ),
      ).toBe("idle");
    });

    it("source=boot but waiting_for_input footer still applies (sandbox approval is sticky)", () => {
      const pane = "something\nPress enter to confirm or esc to cancel";
      expect(observeStatus(state, ctx(pane, { source: "boot", hasObservedSinceBoot: false }))).toBe(
        "waiting_for_input",
      );
    });
  });

  describe("false-positive guard", () => {
    it("classifies false-positive-prompt-text.txt as idle (chrome strings only in body)", () => {
      expect(
        observeStatus(
          state,
          ctx(load("false-positive-prompt-text"), { ticksSinceActivityChange: 2, hasObservedSinceBoot: true }),
        ),
      ).toBe("idle");
    });
  });

  describe("ticksObserved counter", () => {
    it("increments on every observe call", () => {
      observeStatus(state, ctx(""));
      observeStatus(state, ctx(""));
      expect(state.ticksObserved).toBe(2);
    });
  });
});
