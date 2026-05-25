import { describe, expect, it } from "vitest";
import { LAST_OUTPUT_DEBOUNCE_MS, type ReducerPrev, type StatusSignal, reduceStatus } from "./agent-status.js";

const FIXED_NOW = "2026-05-25T12:00:00.000Z";
const now = () => FIXED_NOW;

function prev(over: Partial<ReducerPrev> = {}): ReducerPrev {
  return {
    status: "running",
    lastOutputAt: null,
    statusReason: null,
    ...over,
  };
}

describe("reduceStatus", () => {
  describe("idempotency / three-case return rule", () => {
    it("returns null when status field unchanged and reason same", () => {
      // running × pane_observation(running) — reducer matrix cell "—"
      const result = reduceStatus(prev({ status: "running" }), { type: "pane_observation", observed: "running" }, now);
      expect(result).toBeNull();
    });

    it("advances lastStatusAt only when status field actually changes", () => {
      const result = reduceStatus(prev({ status: "running" }), { type: "pane_observation", observed: "idle" }, now);
      expect(result).not.toBeNull();
      expect(result?.status).toBe("idle");
      expect(result?.lastStatusAt).toBe(FIXED_NOW);
    });

    it("reason-only refinement returns update with statusReason changed, lastStatusAt unchanged", () => {
      // prev unknown(daemon_restart_indeterminate), signal tmux_missing with reason tmux_missing
      const result = reduceStatus(
        prev({ status: "unknown", statusReason: "daemon_restart_indeterminate" }),
        { type: "tmux_missing", reason: "tmux_missing" },
        now,
      );
      expect(result).not.toBeNull();
      expect(result?.status).toBe("unknown");
      expect(result?.reason).toBe("tmux_missing");
      // lastStatusAt is the *prev* timestamp — reducer does not bump it on reason-only
      // (caller writes prev.lastStatusAt; reducer signals "no status change" via the
      //  same-status-different-reason path)
      // We assert this by checking the update doesn't claim to change lastStatusAt
      expect(result?.lastStatusAt).toBeUndefined();
    });

    it("returns null when both status and reason are unchanged on tmux_missing", () => {
      // prev unknown(tmux_missing), signal tmux_missing(tmux_missing) → null
      const result = reduceStatus(
        prev({ status: "unknown", statusReason: "tmux_missing" }),
        { type: "tmux_missing", reason: "tmux_missing" },
        now,
      );
      expect(result).toBeNull();
    });
  });

  describe("launch lifecycle", () => {
    it("launch_succeeded from starting → running", () => {
      const result = reduceStatus(prev({ status: "starting" }), { type: "launch_succeeded" }, now);
      expect(result?.status).toBe("running");
      expect(result?.lastStatusAt).toBe(FIXED_NOW);
    });

    it("launch_failed from starting → failed", () => {
      const result = reduceStatus(prev({ status: "starting" }), { type: "launch_failed", reason: "spawn_failed" }, now);
      expect(result?.status).toBe("failed");
      expect(result?.reason).toBe("spawn_failed");
    });

    it("launch_succeeded is a no-op when already running", () => {
      const result = reduceStatus(prev({ status: "running" }), { type: "launch_succeeded" }, now);
      expect(result).toBeNull();
    });

    it("launch_succeeded re-launches a stopped session to running", () => {
      const result = reduceStatus(prev({ status: "stopped" }), { type: "launch_succeeded" }, now);
      expect(result?.status).toBe("running");
    });

    it("launch_succeeded re-launches a failed session to running", () => {
      const result = reduceStatus(prev({ status: "failed" }), { type: "launch_succeeded" }, now);
      expect(result?.status).toBe("running");
    });
  });

  describe("exit signals carry endedAt and exitCode", () => {
    it("exited_clean → stopped with exitCode 0 and endedAt", () => {
      const result = reduceStatus(
        prev({ status: "running" }),
        { type: "exited_clean", exitCode: 0, endedAt: "2026-05-25T11:59:00.000Z" },
        now,
      );
      expect(result?.status).toBe("stopped");
      expect(result?.exitCode).toBe(0);
      expect(result?.endedAt).toBe("2026-05-25T11:59:00.000Z");
    });

    it("exited_failed → failed with non-zero exitCode", () => {
      const result = reduceStatus(
        prev({ status: "running" }),
        { type: "exited_failed", exitCode: 7, endedAt: "2026-05-25T11:59:00.000Z" },
        now,
      );
      expect(result?.status).toBe("failed");
      expect(result?.exitCode).toBe(7);
    });
  });

  describe("tmux_missing → unknown(reason)", () => {
    it("running × tmux_missing(tmux_missing) → unknown(tmux_missing)", () => {
      const result = reduceStatus(prev({ status: "running" }), { type: "tmux_missing", reason: "tmux_missing" }, now);
      expect(result?.status).toBe("unknown");
      expect(result?.reason).toBe("tmux_missing");
    });

    it("running × tmux_missing(daemon_restart_indeterminate) → unknown(daemon_restart_indeterminate)", () => {
      const result = reduceStatus(
        prev({ status: "running" }),
        { type: "tmux_missing", reason: "daemon_restart_indeterminate" },
        now,
      );
      expect(result?.status).toBe("unknown");
      expect(result?.reason).toBe("daemon_restart_indeterminate");
    });
  });

  describe("active signal — debounce + no transition from idle/waiting_for_input", () => {
    it("active on running with no prior lastOutputAt produces an update", () => {
      const result = reduceStatus(
        prev({ status: "running", lastOutputAt: null }),
        { type: "active", lastOutputAt: "2026-05-25T11:59:59.000Z" },
        now,
      );
      expect(result).not.toBeNull();
      expect(result?.status).toBe("running");
      expect(result?.lastOutputAt).toBe("2026-05-25T11:59:59.000Z");
    });

    it("active under LAST_OUTPUT_DEBOUNCE_MS (1000ms) → null", () => {
      const t0 = new Date("2026-05-25T11:59:58.000Z").toISOString();
      const t500 = new Date("2026-05-25T11:59:58.500Z").toISOString();
      expect(LAST_OUTPUT_DEBOUNCE_MS).toBe(1000);
      const result = reduceStatus(
        prev({ status: "running", lastOutputAt: t0 }),
        { type: "active", lastOutputAt: t500 },
        now,
      );
      expect(result).toBeNull();
    });

    it("active over LAST_OUTPUT_DEBOUNCE_MS → update with new lastOutputAt", () => {
      const t0 = new Date("2026-05-25T11:59:58.000Z").toISOString();
      const t1100 = new Date("2026-05-25T11:59:59.100Z").toISOString();
      const result = reduceStatus(
        prev({ status: "running", lastOutputAt: t0 }),
        { type: "active", lastOutputAt: t1100 },
        now,
      );
      expect(result).not.toBeNull();
      expect(result?.lastOutputAt).toBe(t1100);
      // status unchanged → lastStatusAt should NOT be bumped
      expect(result?.lastStatusAt).toBeUndefined();
    });

    it("active does NOT transition from idle", () => {
      const result = reduceStatus(
        prev({ status: "idle" }),
        { type: "active", lastOutputAt: "2026-05-25T12:00:00.000Z" },
        now,
      );
      expect(result).toBeNull();
    });

    it("active does NOT transition from waiting_for_input", () => {
      const result = reduceStatus(
        prev({ status: "waiting_for_input" }),
        { type: "active", lastOutputAt: "2026-05-25T12:00:00.000Z" },
        now,
      );
      expect(result).toBeNull();
    });
  });

  describe("pane_observation overwrites statusReason to canonical pane value", () => {
    it("idle → pane_observation(running) carries pane:* statusReason", () => {
      const result = reduceStatus(
        prev({ status: "idle", statusReason: "pane:claude-code:idle" }),
        { type: "pane_observation", observed: "running" },
        now,
      );
      expect(result?.status).toBe("running");
      expect(result?.reason).toMatch(/^pane:/);
    });

    it("running → pane_observation(idle) carries pane:* statusReason", () => {
      const result = reduceStatus(prev({ status: "running" }), { type: "pane_observation", observed: "idle" }, now);
      expect(result?.status).toBe("idle");
      expect(result?.reason).toMatch(/^pane:/);
    });

    it("running → pane_observation(waiting_for_input)", () => {
      const result = reduceStatus(
        prev({ status: "running" }),
        { type: "pane_observation", observed: "waiting_for_input" },
        now,
      );
      expect(result?.status).toBe("waiting_for_input");
      expect(result?.reason).toMatch(/^pane:/);
    });

    it("waiting_for_input × pane_observation(running) → running", () => {
      const result = reduceStatus(
        prev({ status: "waiting_for_input" }),
        { type: "pane_observation", observed: "running" },
        now,
      );
      expect(result?.status).toBe("running");
    });

    it("idle × pane_observation(waiting_for_input) → waiting_for_input", () => {
      const result = reduceStatus(
        prev({ status: "idle" }),
        { type: "pane_observation", observed: "waiting_for_input" },
        now,
      );
      expect(result?.status).toBe("waiting_for_input");
    });
  });

  describe("optimistic_send carve-out", () => {
    it("idle × optimistic_send → running with reason optimistic_send", () => {
      const result = reduceStatus(prev({ status: "idle" }), { type: "optimistic_send" }, now);
      expect(result?.status).toBe("running");
      expect(result?.reason).toBe("optimistic_send");
    });

    it("waiting_for_input × optimistic_send → running with reason optimistic_send", () => {
      const result = reduceStatus(prev({ status: "waiting_for_input" }), { type: "optimistic_send" }, now);
      expect(result?.status).toBe("running");
      expect(result?.reason).toBe("optimistic_send");
    });

    it("running × optimistic_send → null (already running)", () => {
      const result = reduceStatus(prev({ status: "running" }), { type: "optimistic_send" }, now);
      expect(result).toBeNull();
    });

    it("stopped × optimistic_send → null (sticky)", () => {
      const result = reduceStatus(prev({ status: "stopped" }), { type: "optimistic_send" }, now);
      expect(result).toBeNull();
    });

    it("unknown × optimistic_send → null", () => {
      const result = reduceStatus(prev({ status: "unknown" }), { type: "optimistic_send" }, now);
      expect(result).toBeNull();
    });
  });

  describe("terminal-state stickiness", () => {
    it("stopped × active → null (no resurrection)", () => {
      const result = reduceStatus(
        prev({ status: "stopped" }),
        { type: "active", lastOutputAt: "2026-05-25T12:00:00.000Z" },
        now,
      );
      expect(result).toBeNull();
    });

    it("stopped × pane_observation(running) → null", () => {
      const result = reduceStatus(prev({ status: "stopped" }), { type: "pane_observation", observed: "running" }, now);
      expect(result).toBeNull();
    });

    it("stopped × tmux_missing → null", () => {
      const result = reduceStatus(prev({ status: "stopped" }), { type: "tmux_missing", reason: "tmux_missing" }, now);
      expect(result).toBeNull();
    });

    it("failed × active → null", () => {
      const result = reduceStatus(
        prev({ status: "failed" }),
        { type: "active", lastOutputAt: "2026-05-25T12:00:00.000Z" },
        now,
      );
      expect(result).toBeNull();
    });

    it("failed × pane_observation(idle) → null", () => {
      const result = reduceStatus(prev({ status: "failed" }), { type: "pane_observation", observed: "idle" }, now);
      expect(result).toBeNull();
    });
  });

  describe("unknown allows exit refinement", () => {
    it("unknown × exited_clean → stopped (recovery from indeterminate)", () => {
      const result = reduceStatus(
        prev({ status: "unknown", statusReason: "daemon_restart_indeterminate" }),
        { type: "exited_clean", exitCode: 0, endedAt: "2026-05-25T11:50:00.000Z" },
        now,
      );
      expect(result?.status).toBe("stopped");
      expect(result?.exitCode).toBe(0);
    });

    it("unknown × pane_observation(running) → running (resurrection)", () => {
      const result = reduceStatus(
        prev({ status: "unknown", statusReason: "sentinel_missing_tmux_alive" }),
        { type: "pane_observation", observed: "running" },
        now,
      );
      expect(result?.status).toBe("running");
    });

    it("unknown × active → running (resurrection)", () => {
      const result = reduceStatus(
        prev({ status: "unknown", statusReason: "tmux_missing" }),
        { type: "active", lastOutputAt: "2026-05-25T12:00:00.000Z" },
        now,
      );
      expect(result?.status).toBe("running");
    });
  });
});
