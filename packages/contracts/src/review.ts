import { z } from "zod";

export const ReviewSuggestionKindSchema = z.enum(["reviewer", "checklist", "note", "warning"]);

export const ReviewSuggestionSchema = z.object({
  id: z.string().min(1).max(120),
  kind: ReviewSuggestionKindSchema,
  label: z.string().min(1).max(200),
  detail: z.string().max(2000).nullable().default(null),
  // http(s) only — zod's .url() accepts javascript:/data: URIs which would be
  // a clickable XSS vector when rendered as <a href> in the cockpit.
  url: z
    .string()
    .url()
    .refine((u) => /^https?:\/\//i.test(u), { message: "url must use http or https" })
    .nullable()
    .default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const ReviewSuggestionsOutputSchema = z.object({
  suggestions: z.array(ReviewSuggestionSchema).max(50).default([]),
  generatedAt: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const ReviewCommentStatusSchema = z.enum(["open", "resolved"]);

export const ReviewCommentSideSchema = z.enum(["LEFT", "RIGHT"]);

export const ReviewCommentSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    filePath: z.string().min(1).max(512).nullable().default(null),
    lineStart: z.number().int().min(1).nullable().default(null),
    lineEnd: z.number().int().min(1).nullable().default(null),
    side: ReviewCommentSideSchema.nullable().default(null),
    author: z.string().min(1).max(80),
    body: z.string().min(1).max(8000),
    status: ReviewCommentStatusSchema.default("open"),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    deletedAt: z.string().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.filePath === null) {
      if (value.lineStart !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lineStart"],
          message: "lineStart requires filePath",
        });
      }
      if (value.lineEnd !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lineEnd"],
          message: "lineEnd requires filePath",
        });
      }
      if (value.side !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["side"],
          message: "side requires filePath",
        });
      }
    }
    if (value.lineStart !== null && value.lineEnd !== null && value.lineEnd < value.lineStart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lineEnd"],
        message: "lineEnd must be >= lineStart",
      });
    }
  });

export const ReviewSuggestionRunStatusSchema = z.enum(["succeeded", "failed", "timed_out"]);

export const ReviewSuggestionRunSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  hookId: z.string().min(1),
  status: ReviewSuggestionRunStatusSchema,
  durationMs: z.number().int().nullable().default(null),
  exitStatus: z.number().int().nullable().default(null),
  output: ReviewSuggestionsOutputSchema.nullable().default(null),
  stderr: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  createdAt: z.string().min(1),
});

export const RequestReviewPayloadSchema = z.object({
  event: z.literal("workspace.requestReview"),
  workspace: z.record(z.unknown()),
  repo: z.record(z.unknown()),
  pr: z.object({
    url: z.string().nullable(),
    branch: z.string(),
    baseBranch: z.string(),
  }),
  diff: z.object({
    files: z.array(z.string()),
    addedLines: z.number().int().nonnegative(),
    deletedLines: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }),
});

export type ReviewSuggestionKind = z.infer<typeof ReviewSuggestionKindSchema>;
export type ReviewSuggestion = z.infer<typeof ReviewSuggestionSchema>;
export type ReviewSuggestionsOutput = z.infer<typeof ReviewSuggestionsOutputSchema>;
export type ReviewCommentStatus = z.infer<typeof ReviewCommentStatusSchema>;
export type ReviewCommentSide = z.infer<typeof ReviewCommentSideSchema>;
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;
export type ReviewSuggestionRunStatus = z.infer<typeof ReviewSuggestionRunStatusSchema>;
export type ReviewSuggestionRun = z.infer<typeof ReviewSuggestionRunSchema>;
export type RequestReviewPayload = z.infer<typeof RequestReviewPayloadSchema>;
