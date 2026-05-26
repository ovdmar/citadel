import type { AgentSession, PullRequestSummary } from "@citadel/contracts";
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
  parentPr: null,
  mergeable: "unknown",
  allowedMergeStrategies: [],
  ...over,
});

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
