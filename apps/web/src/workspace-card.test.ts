import type { AgentSession, PullRequestSummary, TerminalSession, WorkspaceSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { approvalToneFor, deriveWorkspaceAgentTone, prToneFor } from "./workspace-card.js";

const basePr = (over: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 1,
  title: "Test PR",
  url: "https://x.test/pr/1",
  state: "OPEN",
  draft: false,
  reviewDecision: null,
  checks: [],
  additions: 0,
  deletions: 0,
  reviewers: [],
  commits: [],
  headRefName: null,
  parentPr: null,
  mergeable: "unknown",
  allowedMergeStrategies: [],
  mergeStateStatus: null,
  headSha: null,
  ...over,
});

function session(over: Partial<AgentSession>): AgentSession {
  return {
    id: "s",
    workspaceId: "ws",
    kind: "agent",
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

function terminalSession(over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id: "t",
    workspaceId: "ws",
    kind: "terminal",
    runtimeId: null,
    displayName: "Terminal",
    status: "running",
    statusReason: null,
    lastStatusAt: "2026-05-25T12:00:00.000Z",
    lastOutputAt: null,
    endedAt: null,
    exitCode: null,
    transport: "connected",
    tmuxSessionName: "citadel_terminal",
    tmuxSessionId: "$2",
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    ...over,
  } as TerminalSession;
}

describe("prToneFor", () => {
  it("returns 'missing' when no PR exists", () => {
    expect(prToneFor(null)).toBe("missing");
    expect(prToneFor(undefined)).toBe("missing");
  });

  it("returns 'merged' when the PR is merged regardless of check state", () => {
    expect(prToneFor(basePr({ state: "MERGED" }))).toBe("merged");
  });

  it("returns 'missing' when the PR is closed (so the lifecycle slot reads as inactive)", () => {
    expect(prToneFor(basePr({ state: "CLOSED" }))).toBe("missing");
  });

  it("returns 'failing' when any check has a failure-class conclusion", () => {
    expect(
      prToneFor(
        basePr({
          checks: [
            { name: "a", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null },
            { name: "b", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("failing");
  });

  it("returns 'pending' when any check is in-progress and none failed", () => {
    expect(
      prToneFor(
        basePr({
          checks: [
            { name: "a", status: "in_progress", conclusion: null, url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("pending");
  });

  it("returns 'passing' when there are checks and all succeeded", () => {
    expect(
      prToneFor(
        basePr({
          checks: [
            { name: "a", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("passing");
  });

  it("returns 'pending' when there are no checks at all (chip stays cautious until CI surfaces results)", () => {
    expect(prToneFor(basePr({ checks: [] }))).toBe("pending");
  });
});

describe("approvalToneFor", () => {
  it("maps APPROVED → approved, CHANGES_REQUESTED → changes, REVIEW_REQUIRED → pending, else none", () => {
    expect(approvalToneFor(basePr({ reviewDecision: "APPROVED" }))).toBe("approved");
    expect(approvalToneFor(basePr({ reviewDecision: "CHANGES_REQUESTED" }))).toBe("changes");
    expect(approvalToneFor(basePr({ reviewDecision: "REVIEW_REQUIRED" }))).toBe("pending");
    expect(approvalToneFor(basePr({ reviewDecision: null }))).toBe("none");
    expect(approvalToneFor(null)).toBe("none");
  });
});

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

  it("terminal sessions are excluded — running terminal does NOT count as agent running", () => {
    expect(deriveWorkspaceAgentTone([terminalSession({ status: "running" })])).toBe("idle");
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

    it("attention from one session beats running terminal + idle agent", () => {
      expect(
        deriveWorkspaceAgentTone([
          terminalSession({ id: "a", status: "running" }),
          session({ id: "b", status: "waiting_for_input" }),
        ] satisfies WorkspaceSession[]),
      ).toBe("attention");
    });
  });
});

describe("prToneFor — conflicting precedence", () => {
  it("merged PR wins over conflicting", () => {
    expect(prToneFor(basePr({ state: "MERGED", mergeable: "conflicting" }))).toBe("merged");
  });

  it("mergeable=conflicting → conflicting", () => {
    expect(prToneFor(basePr({ mergeable: "conflicting" }))).toBe("conflicting");
  });

  it("mergeStateStatus=DIRTY → conflicting (even if mergeable=unknown)", () => {
    expect(prToneFor(basePr({ mergeable: "unknown", mergeStateStatus: "DIRTY" }))).toBe("conflicting");
  });

  it("mergeable=unknown → not conflicting (transient post-push state)", () => {
    expect(prToneFor(basePr({ mergeable: "unknown" }))).not.toBe("conflicting");
  });

  it("conflicting wins over failing checks", () => {
    expect(
      prToneFor(
        basePr({
          mergeable: "conflicting",
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
        basePr({
          checks: [
            { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      ),
    ).toBe("failing");
  });
});
