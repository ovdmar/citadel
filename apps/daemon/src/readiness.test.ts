import { describe, expect, it } from "vitest";
import { deriveReadiness } from "./readiness.js";

type Input = Parameters<typeof deriveReadiness>[0];

function baseInput(overrides: Partial<Input> = {}): Input {
  return {
    workspace: { lifecycle: "ready", dirty: false },
    sessions: [],
    operations: [],
    providerHealth: [],
    git: { clean: true, conflicted: 0, modified: 0, staged: 0, untracked: 0, checkedAt: "2026-05-25T00:00:00.000Z" },
    versionControl: {
      status: "healthy",
      reason: null,
      pullRequest: null,
      checkedAt: "2026-05-25T00:00:00.000Z",
    },
    ci: { status: "healthy", reason: null, runs: [], checkedAt: "2026-05-25T00:00:00.000Z" },
    apps: { status: "healthy", reason: null, actions: [] },
    ...overrides,
  };
}

const cleanPr = {
  draft: false,
  reviewDecision: "APPROVED" as string | null,
  checks: [{ status: "completed", conclusion: "success" }],
  mergeable: "MERGEABLE" as string | null,
  mergeStateStatus: "CLEAN" as string | null,
};

describe("deriveReadiness — PR conflicts", () => {
  it("emits pr-conflicts (danger) when mergeable=CONFLICTING and no local conflicts", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: "CONFLICTING" },
          checkedAt: "2026-05-25T00:00:00.000Z",
        },
      }),
    );
    expect(r.state).toBe("pr-conflicts");
    expect(r.tone).toBe("danger");
    expect(r.reasons).toContain("PR branch has merge conflicts with the base branch");
  });

  it("local working-tree conflicts win over pr-conflicts (local fix comes first)", () => {
    const r = deriveReadiness(
      baseInput({
        git: { clean: false, conflicted: 2, modified: 0, staged: 0, untracked: 0, checkedAt: "x" },
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: "CONFLICTING" },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).toBe("conflicts");
  });

  it("blocked state still wins over pr-conflicts", () => {
    const r = deriveReadiness(
      baseInput({
        workspace: { lifecycle: "failed", dirty: false },
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: "CONFLICTING" },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).toBe("blocked");
  });

  it("compound case: pr-conflicts surfaces failing-check reason too when CI is also red", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: {
            ...cleanPr,
            mergeable: "CONFLICTING",
            checks: [{ status: "completed", conclusion: "failure" }],
          },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).toBe("pr-conflicts");
    expect(r.reasons).toContain("One or more PR checks are failing");
    expect(r.reasons).toContain("PR branch has merge conflicts with the base branch");
  });

  it("ready-to-merge is gated on mergeable !== CONFLICTING", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: cleanPr,
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).toBe("ready-to-merge");
  });

  it("ready-to-merge still fires when mergeable=UNKNOWN (transient — does NOT block)", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: "UNKNOWN" },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).toBe("ready-to-merge");
  });

  it("pr-conflicts does NOT fire when mergeable=UNKNOWN", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: "UNKNOWN", reviewDecision: null },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).not.toBe("pr-conflicts");
  });

  it("pr-conflicts does NOT fire when mergeable is null (no provider data)", () => {
    const r = deriveReadiness(
      baseInput({
        versionControl: {
          status: "healthy",
          reason: null,
          pullRequest: { ...cleanPr, mergeable: null, reviewDecision: null },
          checkedAt: "x",
        },
      }),
    );
    expect(r.state).not.toBe("pr-conflicts");
  });
});
