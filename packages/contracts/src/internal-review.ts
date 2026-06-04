import { z } from "zod";
import { IdSchema } from "./primitives.js";

export const ReviewDiffBucketSchema = z.enum(["against-base", "staged", "unstaged"]);
export const ReviewDiffSideSchema = z.enum(["old", "new"]);
export const ReviewThreadKindSchema = z.enum(["internal", "external"]);
export const ReviewThreadStatusSchema = z.enum(["open", "resolved"]);
export const ReviewAnchorStateSchema = z.enum(["current", "outdated"]);
export const ReviewAnchorKindSchema = z.enum(["line", "file"]);
export const ReviewAuthorKindSchema = z.enum(["user", "agent", "system"]);
export const ReviewScopeProviderStateSchema = z.enum(["open", "merged", "closed", "unknown"]);

export const ReviewDiffFileStatusSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "conflicted",
  "mode-only",
  "submodule",
  "unknown",
]);

export const ReviewDiffBaseSchema = z.object({
  baseBranch: z.string().min(1),
  baseRef: z.string().min(1).nullable().default(null),
  baseTipSha: z.string().min(1).nullable().default(null),
  mergeBaseSha: z.string().min(1).nullable().default(null),
  headSha: z.string().min(1).nullable().default(null),
  missing: z.boolean().default(false),
  freshness: z.enum(["fresh", "not_refreshed", "missing"]).default("not_refreshed"),
});

export const ReviewDiffWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
});

export const ReviewDiffCommitSchema = z.object({
  sha: z.string().min(7),
  shortSha: z.string().min(4),
  subject: z.string(),
  author: z.string(),
  isoTime: z.string().nullable().default(null),
});

export const ReviewDiffFileIdentitySchema = z.object({
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().default(null),
  baseSha: z.string().min(1).nullable().default(null),
  headSha: z.string().min(1).nullable().default(null),
  oldBlobSha: z.string().min(1).nullable().default(null),
  newBlobSha: z.string().min(1).nullable().default(null),
  worktreeHash: z.string().min(1).nullable().default(null),
});

export const ReviewDiffFileSummarySchema = z.object({
  id: z.string().min(1),
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().default(null),
  status: ReviewDiffFileStatusSchema,
  binary: z.boolean().default(false),
  tooLarge: z.boolean().default(false),
  truncated: z.boolean().default(false),
  commentable: z.boolean().default(true),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  threadCount: z.number().int().nonnegative().default(0),
  openThreadCount: z.number().int().nonnegative().default(0),
  viewed: z.boolean().default(false),
  identity: ReviewDiffFileIdentitySchema,
});

export const ReviewDiffSectionSchema = z.object({
  bucket: ReviewDiffBucketSchema,
  label: z.string().min(1),
  files: z.array(ReviewDiffFileSummarySchema),
  fileCount: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
});

export const InternalReviewScopeSummarySchema = z.object({
  id: IdSchema,
  workspaceId: IdSchema,
  checkoutId: IdSchema,
  repoId: IdSchema,
  providerType: z.string().min(1),
  providerRepositoryKey: z.string().min(1).nullable().default(null),
  externalReviewId: z.string().min(1).nullable().default(null),
  externalReviewNumber: z.number().int().positive().nullable().default(null),
  externalReviewUrl: z.string().url().nullable().default(null),
  baseRef: z.string().min(1).nullable().default(null),
  headRef: z.string().min(1).nullable().default(null),
  headSha: z.string().min(1).nullable().default(null),
  providerState: ReviewScopeProviderStateSchema.default("unknown"),
  observedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ReviewDiffMetadataSchema = z.object({
  checkoutId: IdSchema,
  workspaceId: IdSchema,
  repoId: IdSchema,
  reviewScope: InternalReviewScopeSummarySchema.nullable().default(null),
  base: ReviewDiffBaseSchema,
  sections: z.array(ReviewDiffSectionSchema),
  commits: z.array(ReviewDiffCommitSchema).default([]),
  warnings: z.array(ReviewDiffWarningSchema).default([]),
  checkedAt: z.string(),
});

export const ReviewDiffFileContentSchema = z.object({
  checkoutId: IdSchema,
  fileId: z.string().min(1),
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().default(null),
  status: ReviewDiffFileStatusSchema,
  binary: z.boolean().default(false),
  tooLarge: z.boolean().default(false),
  truncated: z.boolean().default(false),
  oldContent: z.string().nullable().default(null),
  newContent: z.string().nullable().default(null),
});

export const InternalReviewThreadReplySchema = z.object({
  id: IdSchema,
  threadId: IdSchema,
  body: z.string().min(1),
  authorKind: ReviewAuthorKindSchema,
  authorLabel: z.string().min(1).nullable().default(null),
  providerCommentId: z.string().min(1).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const InternalReviewThreadSchema = z.object({
  id: IdSchema,
  reviewScopeId: IdSchema,
  kind: ReviewThreadKindSchema.default("internal"),
  status: ReviewThreadStatusSchema.default("open"),
  anchorState: ReviewAnchorStateSchema.default("current"),
  anchorKind: ReviewAnchorKindSchema,
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().default(null),
  side: ReviewDiffSideSchema.nullable().default(null),
  startLine: z.number().int().positive().nullable().default(null),
  endLine: z.number().int().positive().nullable().default(null),
  diffIdentity: z.string().min(1),
  selectedText: z.string().nullable().default(null),
  authorKind: ReviewAuthorKindSchema,
  authorLabel: z.string().min(1).nullable().default(null),
  providerThreadId: z.string().min(1).nullable().default(null),
  resolvedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  replies: z.array(InternalReviewThreadReplySchema).default([]),
});

export const ListReviewThreadsInputSchema = z.object({
  checkoutId: IdSchema.optional(),
  reviewScopeId: IdSchema.optional(),
  includeResolved: z.boolean().default(false),
  includeOutdated: z.boolean().default(false),
});

export const CreateReviewThreadInputSchema = z.object({
  checkoutId: IdSchema.optional(),
  reviewScopeId: IdSchema.optional(),
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().optional(),
  anchorKind: ReviewAnchorKindSchema,
  side: ReviewDiffSideSchema.optional(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  selectedText: z.string().optional(),
  authorKind: ReviewAuthorKindSchema.default("user"),
  authorLabel: z.string().min(1).optional(),
  body: z.string().min(1),
});

export const ReplyReviewThreadInputSchema = z.object({
  threadId: IdSchema,
  body: z.string().min(1),
  authorKind: ReviewAuthorKindSchema.default("user"),
  authorLabel: z.string().min(1).optional(),
});

export const ReviewThreadIdInputSchema = z.object({
  threadId: IdSchema,
});

export const MarkReviewFileViewedInputSchema = z.object({
  reviewScopeId: IdSchema,
  fileId: z.string().min(1),
  bucket: ReviewDiffBucketSchema,
  path: z.string().min(1),
  oldPath: z.string().min(1).nullable().default(null),
  diffIdentity: z.string().min(1),
  viewed: z.boolean().default(true),
});

export const ReviewActionWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  paths: z.array(z.string()).default([]),
});

export const CreatePullRequestInputSchema = z.object({
  checkoutId: IdSchema,
});

export const PushBranchInputSchema = z.object({
  checkoutId: IdSchema,
});

export const CreatePullRequestResultSchema = z.object({
  ok: z.boolean(),
  checkoutId: IdSchema,
  reviewScope: InternalReviewScopeSummarySchema.nullable().default(null),
  prUrl: z.string().url().nullable().default(null),
  operationId: IdSchema.nullable().default(null),
  warnings: z.array(ReviewActionWarningSchema).default([]),
  error: z.string().nullable().default(null),
});

export const PushBranchResultSchema = z.object({
  ok: z.boolean(),
  checkoutId: IdSchema,
  operationId: IdSchema.nullable().default(null),
  warnings: z.array(ReviewActionWarningSchema).default([]),
  error: z.string().nullable().default(null),
});

export type ReviewDiffBucket = z.infer<typeof ReviewDiffBucketSchema>;
export type ReviewDiffSide = z.infer<typeof ReviewDiffSideSchema>;
export type ReviewThreadKind = z.infer<typeof ReviewThreadKindSchema>;
export type ReviewThreadStatus = z.infer<typeof ReviewThreadStatusSchema>;
export type ReviewAnchorState = z.infer<typeof ReviewAnchorStateSchema>;
export type ReviewAnchorKind = z.infer<typeof ReviewAnchorKindSchema>;
export type ReviewAuthorKind = z.infer<typeof ReviewAuthorKindSchema>;
export type ReviewScopeProviderState = z.infer<typeof ReviewScopeProviderStateSchema>;
export type ReviewDiffFileStatus = z.infer<typeof ReviewDiffFileStatusSchema>;
export type ReviewDiffBase = z.infer<typeof ReviewDiffBaseSchema>;
export type ReviewDiffWarning = z.infer<typeof ReviewDiffWarningSchema>;
export type ReviewDiffCommit = z.infer<typeof ReviewDiffCommitSchema>;
export type ReviewDiffFileIdentity = z.infer<typeof ReviewDiffFileIdentitySchema>;
export type ReviewDiffFileSummary = z.infer<typeof ReviewDiffFileSummarySchema>;
export type ReviewDiffSection = z.infer<typeof ReviewDiffSectionSchema>;
export type InternalReviewScopeSummary = z.infer<typeof InternalReviewScopeSummarySchema>;
export type ReviewDiffMetadata = z.infer<typeof ReviewDiffMetadataSchema>;
export type ReviewDiffFileContent = z.infer<typeof ReviewDiffFileContentSchema>;
export type InternalReviewThreadReply = z.infer<typeof InternalReviewThreadReplySchema>;
export type InternalReviewThread = z.infer<typeof InternalReviewThreadSchema>;
export type ListReviewThreadsInput = z.infer<typeof ListReviewThreadsInputSchema>;
export type CreateReviewThreadInput = z.infer<typeof CreateReviewThreadInputSchema>;
export type ReplyReviewThreadInput = z.infer<typeof ReplyReviewThreadInputSchema>;
export type ReviewThreadIdInput = z.infer<typeof ReviewThreadIdInputSchema>;
export type MarkReviewFileViewedInput = z.infer<typeof MarkReviewFileViewedInputSchema>;
export type ReviewActionWarning = z.infer<typeof ReviewActionWarningSchema>;
export type CreatePullRequestInput = z.infer<typeof CreatePullRequestInputSchema>;
export type PushBranchInput = z.infer<typeof PushBranchInputSchema>;
export type CreatePullRequestResult = z.infer<typeof CreatePullRequestResultSchema>;
export type PushBranchResult = z.infer<typeof PushBranchResultSchema>;
