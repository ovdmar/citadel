import { describe, expect, it } from "vitest";
import {
  CreatePullRequestResultSchema,
  CreateReviewThreadInputSchema,
  InternalReviewThreadSchema,
  ListReviewThreadsInputSchema,
  ReviewDiffMetadataSchema,
} from "./internal-review.js";

const timestamp = "2026-06-04T00:00:00.000Z";

describe("internal review contracts", () => {
  it("validates checkout review diff metadata with separate bucket identities", () => {
    const metadata = ReviewDiffMetadataSchema.parse({
      checkoutId: "checkout_test",
      workspaceId: "ws_test",
      repoId: "repo_test",
      base: {
        baseBranch: "main",
        baseRef: "origin/main",
        baseTipSha: "base_tip",
        mergeBaseSha: "merge_base",
        headSha: "head_sha",
      },
      sections: [
        {
          bucket: "against-base",
          label: "Committed vs base",
          fileCount: 1,
          files: [
            {
              id: "against-base:README.md",
              bucket: "against-base",
              path: "README.md",
              status: "modified",
              additions: 2,
              deletions: 1,
              identity: {
                bucket: "against-base",
                path: "README.md",
                baseSha: "merge_base",
                headSha: "head_sha",
              },
            },
          ],
        },
        {
          bucket: "unstaged",
          label: "Unstaged",
          fileCount: 1,
          files: [
            {
              id: "unstaged:README.md",
              bucket: "unstaged",
              path: "README.md",
              status: "modified",
              identity: {
                bucket: "unstaged",
                path: "README.md",
                worktreeHash: "hash",
              },
            },
          ],
        },
      ],
      checkedAt: timestamp,
    });

    expect(metadata.base.freshness).toBe("not_refreshed");
    expect(metadata.sections[0]?.files[0]?.identity.bucket).toBe("against-base");
    expect(metadata.sections[1]?.files[0]?.identity.bucket).toBe("unstaged");
  });

  it("validates internal thread creation and default filters", () => {
    expect(ListReviewThreadsInputSchema.parse({ reviewScopeId: "scope_test" })).toEqual({
      reviewScopeId: "scope_test",
      includeResolved: false,
      includeOutdated: false,
    });

    const threadInput = CreateReviewThreadInputSchema.parse({
      checkoutId: "checkout_test",
      bucket: "staged",
      path: "src/app.ts",
      anchorKind: "line",
      side: "new",
      startLine: 12,
      selectedText: "const value = true;",
      body: "Please simplify this.",
    });
    expect(threadInput.endLine).toBeUndefined();
    expect(threadInput.authorKind).toBe("user");
    expect(threadInput.selectedText).toBe("const value = true;");
  });

  it("validates persisted threads and PR action results", () => {
    const thread = InternalReviewThreadSchema.parse({
      id: "thread_test",
      reviewScopeId: "scope_test",
      anchorKind: "file",
      bucket: "against-base",
      path: "README.md",
      diffIdentity: "against-base:README.md:head",
      authorKind: "agent",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    expect(thread.kind).toBe("internal");
    expect(thread.status).toBe("open");
    expect(thread.anchorState).toBe("current");

    const result = CreatePullRequestResultSchema.parse({
      ok: true,
      checkoutId: "checkout_test",
      prUrl: "https://github.com/owner/repo/pull/1",
      warnings: [{ code: "dirty_excluded", message: "Dirty changes are not included.", paths: ["README.md"] }],
    });

    expect(result.reviewScope).toBeNull();
    expect(result.warnings[0]?.paths).toEqual(["README.md"]);
  });
});
