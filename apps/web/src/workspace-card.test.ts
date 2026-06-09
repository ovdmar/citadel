import type { PullRequestSummary } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { approvalToneFor, lifecycleToneClass, prToneFor } from "./workspace-card.js";

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

describe("lifecycleToneClass", () => {
  it("maps lifecycle tones to pulse classes", () => {
    expect(lifecycleToneClass("never-started")).toBe("cit-pulse-idle");
    expect(lifecycleToneClass("running")).toBe("cit-pulse-run");
    expect(lifecycleToneClass("done")).toBe("cit-pulse-idle");
    expect(lifecycleToneClass("attention")).toBe("cit-pulse-bad");
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
