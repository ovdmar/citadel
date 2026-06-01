import { describe, expect, it } from "vitest";
import { type AutoRecoveryDecisionInput, decideAutoRecoveryAction } from "./auto-recovery.js";

function base(overrides: Partial<AutoRecoveryDecisionInput> = {}): AutoRecoveryDecisionInput {
  return {
    workspace: { id: "ws_test", autoRecoveryLastCiSha: null, autoRecoveryLastAttemptAt: null },
    sessions: [],
    pr: { headSha: "abc1234", mergeable: "mergeable", checks: [{ status: "completed", conclusion: "failure" }] },
    runtimeId: "claude-code",
    now: new Date("2026-05-25T12:00:00.000Z"),
    idleThresholdMs: 300_000,
    debounceMs: 1_800_000,
    disabled: false,
    ...overrides,
  };
}

describe("decideAutoRecoveryAction", () => {
  it("fires when CI is red, no active sessions, idle ≥ threshold, fresh SHA", () => {
    const decision = decideAutoRecoveryAction(base());
    expect(decision.fire).toBe(true);
    expect(decision.sha).toBe("abc1234");
    expect(decision.reason).toBe("ci_red_new_sha");
  });

  it("fires when same-SHA CI re-runs after debounce expires", () => {
    const decision = decideAutoRecoveryAction(
      base({
        workspace: {
          id: "ws_test",
          autoRecoveryLastCiSha: "abc1234",
          autoRecoveryLastAttemptAt: "2026-05-25T10:00:00.000Z", // 2 h ago > 30 min debounce
        },
      }),
    );
    expect(decision.fire).toBe(true);
    expect(decision.reason).toBe("ci_red_debounce_expired");
  });

  it("skips when an agent session is starting/running", () => {
    const decision = decideAutoRecoveryAction(
      base({ sessions: [{ status: "running", runtimeId: "claude-code", lastActivityAt: null }] }),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("agent_session_active");
  });

  it("ignores running shell-runtime sessions when deciding if an agent is active", () => {
    const decision = decideAutoRecoveryAction(
      base({ sessions: [{ status: "running", runtimeId: "shell", lastActivityAt: null }] }),
    );
    expect(decision.fire).toBe(true);
  });

  it("skips when latest session activity is within the idle window", () => {
    const decision = decideAutoRecoveryAction(
      base({
        sessions: [
          // 1 min ago — well under the 5 min default threshold.
          { status: "stopped", runtimeId: "claude-code", lastActivityAt: "2026-05-25T11:59:00.000Z" },
        ],
      }),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("within_idle_window");
  });

  it("fires when latest activity is older than the idle window", () => {
    const decision = decideAutoRecoveryAction(
      base({
        sessions: [
          // 10 min ago — past the 5 min default threshold.
          { status: "stopped", runtimeId: "claude-code", lastActivityAt: "2026-05-25T11:50:00.000Z" },
        ],
      }),
    );
    expect(decision.fire).toBe(true);
  });

  it("dedupes when same SHA was pinged within the debounce window", () => {
    const decision = decideAutoRecoveryAction(
      base({
        workspace: {
          id: "ws_test",
          autoRecoveryLastCiSha: "abc1234",
          // 10 min ago < 30 min debounce.
          autoRecoveryLastAttemptAt: "2026-05-25T11:50:00.000Z",
        },
      }),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("sha_dedupe_and_debounced");
  });

  it("skips when no runtime is configured", () => {
    const decision = decideAutoRecoveryAction(base({ runtimeId: null }));
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no_runtime_configured");
  });

  it("skips when disabled flag is set", () => {
    const decision = decideAutoRecoveryAction(base({ disabled: true }));
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("auto_recovery_disabled");
  });

  it("skips when PR is null", () => {
    const decision = decideAutoRecoveryAction(base({ pr: null }));
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no_pr_or_head_sha");
  });

  it("skips when PR has no head SHA", () => {
    const decision = decideAutoRecoveryAction(
      base({ pr: { headSha: null, mergeable: "mergeable", checks: [{ status: "completed", conclusion: "failure" }] } }),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("no_pr_or_head_sha");
  });

  it("skips when CI has no failing checks", () => {
    const decision = decideAutoRecoveryAction(
      base({
        pr: { headSha: "abc1234", mergeable: "mergeable", checks: [{ status: "completed", conclusion: "success" }] },
      }),
    );
    expect(decision.fire).toBe(false);
    expect(decision.reason).toBe("ci_not_failing");
  });

  it("returns the headSha to persist on fire", () => {
    const decision = decideAutoRecoveryAction(
      base({
        pr: { headSha: "deadbeef", mergeable: "mergeable", checks: [{ status: "completed", conclusion: "failure" }] },
      }),
    );
    expect(decision.fire).toBe(true);
    expect(decision.sha).toBe("deadbeef");
  });
});
