import { describe, expect, it } from "vitest";
import {
  RequestReviewPayloadSchema,
  ReviewCommentSchema,
  ReviewSuggestionRunSchema,
  ReviewSuggestionSchema,
  ReviewSuggestionsOutputSchema,
} from "./review.js";

describe("ReviewSuggestionsOutputSchema", () => {
  it("parses a fully-omitted object via inner defaults", () => {
    const parsed = ReviewSuggestionsOutputSchema.parse({});
    expect(parsed).toEqual({ suggestions: [], generatedAt: null, metadata: {} });
  });

  it("parses a fully specified payload", () => {
    const parsed = ReviewSuggestionsOutputSchema.parse({
      suggestions: [
        {
          id: "s1",
          kind: "reviewer",
          label: "@alice",
          detail: "module owner",
          url: "https://example.com/owners",
        },
      ],
      generatedAt: "2026-01-01T00:00:00.000Z",
      metadata: { source: "codeowners" },
    });
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]?.kind).toBe("reviewer");
    expect(parsed.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects more than 50 suggestions", () => {
    const tooMany = Array.from({ length: 51 }, (_, idx) => ({
      id: `s${idx}`,
      kind: "note" as const,
      label: "x",
    }));
    expect(() => ReviewSuggestionsOutputSchema.parse({ suggestions: tooMany })).toThrow();
  });

  it("rejects an unknown suggestion kind", () => {
    expect(() => ReviewSuggestionSchema.parse({ id: "s", kind: "bogus", label: "x" })).toThrow();
  });

  it("rejects suggestion label over 200 chars", () => {
    expect(() => ReviewSuggestionSchema.parse({ id: "s", kind: "note", label: "x".repeat(201) })).toThrow();
  });

  it("rejects suggestion url that is not a URL", () => {
    expect(() => ReviewSuggestionSchema.parse({ id: "s", kind: "reviewer", label: "y", url: "not-a-url" })).toThrow();
  });

  it("rejects javascript: and data: URLs even if they parse as URL()", () => {
    expect(() =>
      ReviewSuggestionSchema.parse({ id: "s", kind: "reviewer", label: "y", url: "javascript:alert(1)" }),
    ).toThrow();
    expect(() =>
      ReviewSuggestionSchema.parse({ id: "s", kind: "reviewer", label: "y", url: "data:text/html,hi" }),
    ).toThrow();
  });

  it("accepts http and https URLs", () => {
    expect(
      ReviewSuggestionSchema.parse({ id: "s", kind: "reviewer", label: "y", url: "https://x.test/path" }).url,
    ).toBe("https://x.test/path");
    expect(ReviewSuggestionSchema.parse({ id: "s", kind: "reviewer", label: "y", url: "http://x.test/path" }).url).toBe(
      "http://x.test/path",
    );
  });

  it("defaults nullable fields to null instead of undefined", () => {
    const parsed = ReviewSuggestionSchema.parse({ id: "s", kind: "note", label: "x" });
    expect(parsed.detail).toBeNull();
    expect(parsed.url).toBeNull();
    expect(parsed.metadata).toEqual({});
  });
});

describe("ReviewCommentSchema", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const base = {
    id: "rc_1",
    workspaceId: "ws_1",
    author: "operator",
    body: "looks good",
    status: "open" as const,
    createdAt: now,
    updatedAt: now,
  };

  it("accepts a PR-level comment with all anchors null", () => {
    const parsed = ReviewCommentSchema.parse(base);
    expect(parsed.filePath).toBeNull();
    expect(parsed.lineStart).toBeNull();
    expect(parsed.lineEnd).toBeNull();
    expect(parsed.side).toBeNull();
    expect(parsed.deletedAt).toBeNull();
  });

  it("accepts a file/line scoped comment", () => {
    const parsed = ReviewCommentSchema.parse({
      ...base,
      filePath: "src/main.ts",
      lineStart: 10,
      lineEnd: 12,
      side: "RIGHT",
    });
    expect(parsed.filePath).toBe("src/main.ts");
    expect(parsed.lineEnd).toBe(12);
  });

  it("rejects lineEnd < lineStart", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, filePath: "a.ts", lineStart: 10, lineEnd: 5 })).toThrow();
  });

  it("rejects negative line numbers", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, filePath: "a.ts", lineStart: -1 })).toThrow();
  });

  it("rejects an empty body", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, body: "" })).toThrow();
  });

  it("rejects a body over 8000 chars", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, body: "x".repeat(8001) })).toThrow();
  });

  it("rejects lineStart without filePath", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, lineStart: 1 })).toThrow();
  });

  it("rejects side without filePath", () => {
    expect(() => ReviewCommentSchema.parse({ ...base, side: "LEFT" })).toThrow();
  });
});

describe("ReviewSuggestionRunSchema", () => {
  const now = "2026-01-01T00:00:00.000Z";
  it("parses a succeeded run", () => {
    const parsed = ReviewSuggestionRunSchema.parse({
      id: "run_1",
      workspaceId: "ws_1",
      hookId: "hook_1",
      status: "succeeded",
      durationMs: 120,
      exitStatus: 0,
      output: { suggestions: [], generatedAt: null, metadata: {} },
      createdAt: now,
    });
    expect(parsed.status).toBe("succeeded");
    expect(parsed.stderr).toBeNull();
    expect(parsed.error).toBeNull();
  });

  it("parses a failed run with stderr + error", () => {
    const parsed = ReviewSuggestionRunSchema.parse({
      id: "run_2",
      workspaceId: "ws_1",
      hookId: "hook_1",
      status: "failed",
      durationMs: 50,
      exitStatus: 1,
      stderr: "boom",
      error: "Hook exited with 1",
      createdAt: now,
    });
    expect(parsed.status).toBe("failed");
    expect(parsed.output).toBeNull();
  });

  it("rejects an unknown status", () => {
    expect(() =>
      ReviewSuggestionRunSchema.parse({
        id: "run_3",
        workspaceId: "ws_1",
        hookId: "hook_1",
        status: "weird",
        createdAt: now,
      }),
    ).toThrow();
  });
});

describe("RequestReviewPayloadSchema", () => {
  it("requires the literal event and a string[] files list", () => {
    const parsed = RequestReviewPayloadSchema.parse({
      event: "workspace.requestReview",
      workspace: { id: "ws_1", name: "w", branch: "b" },
      repo: { id: "repo_1", name: "r" },
      pr: { url: null, branch: "feature", baseBranch: "main" },
      diff: { files: ["src/a.ts", "src/b.ts"], addedLines: 10, deletedLines: 2, truncated: false },
    });
    expect(parsed.diff.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("rejects non-string entries in diff.files", () => {
    expect(() =>
      RequestReviewPayloadSchema.parse({
        event: "workspace.requestReview",
        workspace: { id: "ws_1" },
        repo: { id: "repo_1" },
        pr: { url: null, branch: "f", baseBranch: "main" },
        diff: { files: [123], addedLines: 0, deletedLines: 0, truncated: false },
      }),
    ).toThrow();
  });

  it("rejects negative line counts", () => {
    expect(() =>
      RequestReviewPayloadSchema.parse({
        event: "workspace.requestReview",
        workspace: { id: "ws_1" },
        repo: { id: "repo_1" },
        pr: { url: null, branch: "f", baseBranch: "main" },
        diff: { files: [], addedLines: -1, deletedLines: 0, truncated: false },
      }),
    ).toThrow();
  });
});
