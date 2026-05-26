import type { AgentSession, PullRequestSummary } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { deriveWorkspaceAgentTone, prToneFor } from "./workspace-card.js";

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "s",
    workspaceId: "ws",
    runtimeId: "claude-code",
    displayName: "Test",
    status: "running",
    statusReason: null,
    lastStatusAt: "2026-05-25T12:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "disconnected",
    tmuxSessionName: "citadel_test",
    tmuxSessionId: "$1",
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    ...over,
  } as AgentSession;
}

describe("deriveWorkspaceAgentTone", () => {
  it("empty workspace → idle", () => {
    expect(deriveWorkspaceAgentTone([])).toBe("idle");
  });

  it("any running agent → running", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "running" })])).toBe("running");
  });

  it("any starting agent → running", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "starting" })])).toBe("running");
  });

  it("any waiting_for_input → attention", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "waiting_for_input" })])).toBe("attention");
  });

  it("any failed → attention", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "failed" })])).toBe("attention");
  });

  it("unknown with tmux_missing reason → attention", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "unknown", statusReason: "tmux_missing" })])).toBe("attention");
  });

  it("unknown with migrated_from_orphaned → attention", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "unknown", statusReason: "migrated_from_orphaned" })])).toBe(
      "attention",
    );
  });

  it("unknown with sentinel_missing_tmux_alive → attention", () => {
    expect(
      deriveWorkspaceAgentTone([session({ status: "unknown", statusReason: "sentinel_missing_tmux_alive" })]),
    ).toBe("attention");
  });

  it("unknown with daemon_restart_indeterminate → idle (neutral, no alarm)", () => {
    expect(
      deriveWorkspaceAgentTone([session({ status: "unknown", statusReason: "daemon_restart_indeterminate" })]),
    ).toBe("idle");
  });

  it("stopped session → idle", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "stopped" })])).toBe("idle");
  });

  it("plain idle session → idle", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "idle" })])).toBe("idle");
  });

  it("any rate_limited → rate_limited", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "rate_limited" })])).toBe("rate_limited");
  });

  it("any usage_limited collapses into the rate_limited tone (same blue dot)", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "usage_limited" })])).toBe("rate_limited");
  });

  it("shell-runtime sessions are excluded — running shell does NOT count as agent running", () => {
    expect(deriveWorkspaceAgentTone([session({ status: "running", runtimeId: "shell" })])).toBe("idle");
  });

  describe("priority: attention > running > idle", () => {
    it("one waiting_for_input + one running → attention", () => {
      expect(
        deriveWorkspaceAgentTone([
          session({ id: "a", status: "running" }),
          session({ id: "b", status: "waiting_for_input" }),
        ]),
      ).toBe("attention");
    });

    it("one failed + one running → attention", () => {
      expect(
        deriveWorkspaceAgentTone([session({ id: "a", status: "running" }), session({ id: "b", status: "failed" })]),
      ).toBe("attention");
    });

    it("one running + one idle → running", () => {
      expect(
        deriveWorkspaceAgentTone([session({ id: "a", status: "running" }), session({ id: "b", status: "idle" })]),
      ).toBe("running");
    });

    it("rate_limited beats running", () => {
      expect(
        deriveWorkspaceAgentTone([
          session({ id: "a", status: "running" }),
          session({ id: "b", status: "rate_limited" }),
        ]),
      ).toBe("rate_limited");
    });

    it("attention beats rate_limited", () => {
      expect(
        deriveWorkspaceAgentTone([
          session({ id: "a", status: "rate_limited" }),
          session({ id: "b", status: "waiting_for_input" }),
        ]),
      ).toBe("attention");
    });

    it("one stopped + one idle → idle", () => {
      expect(
        deriveWorkspaceAgentTone([session({ id: "a", status: "stopped" }), session({ id: "b", status: "idle" })]),
      ).toBe("idle");
    });

    it("attention from one session beats running shell + idle agent", () => {
      expect(
        deriveWorkspaceAgentTone([
          session({ id: "a", status: "running", runtimeId: "shell" }),
          session({ id: "b", status: "waiting_for_input" }),
        ]),
      ).toBe("attention");
    });
  });
});

function pr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: "PR",
    url: "https://example.test/pr/1",
    state: "OPEN",
    draft: false,
    reviewDecision: null,
    additions: 0,
    deletions: 0,
    reviewers: [],
    checks: [],
    mergeable: null,
    mergeStateStatus: null,
    headSha: null,
    ...over,
  };
}

describe("prToneFor", () => {
  it("null PR → missing", () => {
    expect(prToneFor(null)).toBe("missing");
  });

  it("merged PR → merged (wins over conflicting)", () => {
    expect(prToneFor(pr({ state: "MERGED", mergeable: "CONFLICTING" }))).toBe("merged");
  });

  it("closed PR → missing", () => {
    expect(prToneFor(pr({ state: "CLOSED" }))).toBe("missing");
  });

  it("mergeable=CONFLICTING → conflicting", () => {
    expect(prToneFor(pr({ mergeable: "CONFLICTING" }))).toBe("conflicting");
  });

  it("mergeStateStatus=DIRTY → conflicting (even if mergeable is null)", () => {
    expect(prToneFor(pr({ mergeable: null, mergeStateStatus: "DIRTY" }))).toBe("conflicting");
  });

  it("mergeable=UNKNOWN → not conflicting (transient)", () => {
    expect(prToneFor(pr({ mergeable: "UNKNOWN" }))).not.toBe("conflicting");
  });

  it("mergeable=null → not conflicting (no provider data)", () => {
    expect(prToneFor(pr({ mergeable: null }))).not.toBe("conflicting");
  });

  it("conflicting wins over failing (PR with both failing checks and conflicts)", () => {
    expect(
      prToneFor(
        pr({
          mergeable: "CONFLICTING",
          checks: [
            { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("conflicting");
  });

  it("failing checks without conflict → failing", () => {
    expect(
      prToneFor(
        pr({
          checks: [
            { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("failing");
  });
});
