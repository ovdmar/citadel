import type { McpToolDefinition } from "./index.js";

export const reviewMcpToolDefinitions: McpToolDefinition[] = [
  {
    name: "list_review_comments",
    description:
      "List Citadel-native review comments for a workspace. Comments are stored in Citadel's SQLite (not GitHub); each carries optional file/line anchors and a status of 'open' or 'resolved'. Returns newest-first. status defaults to 'all'; includeDeleted defaults to false.",
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        status: { type: "string", enum: ["open", "resolved", "all"] },
        includeDeleted: { type: "boolean" },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "add_review_comment",
    description:
      "Add a Citadel-native review comment on a workspace. The daemon stamps author='agent:<runtime-id>'; callers cannot supply author. Anchors are optional — pass filePath + lineStart (+ optional lineEnd, side) to scope to a file:line range.",
    inputSchema: {
      type: "object",
      required: ["workspaceId", "body"],
      properties: {
        workspaceId: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1, maxLength: 8000 },
        filePath: { type: "string", minLength: 1, maxLength: 512 },
        lineStart: { type: "integer", minimum: 1 },
        lineEnd: { type: "integer", minimum: 1 },
        side: { type: "string", enum: ["LEFT", "RIGHT"] },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "update_review_comment",
    description:
      "Update a review comment's body and/or status. Requires ifUpdatedAtMatches (the comment's last-read updatedAt) — mismatched tokens return { error: 'conflict', latest } so the caller can re-read and retry.",
    inputSchema: {
      type: "object",
      required: ["id", "ifUpdatedAtMatches"],
      properties: {
        id: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1, maxLength: 8000 },
        status: { type: "string", enum: ["open", "resolved"] },
        ifUpdatedAtMatches: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: "delete_review_comment",
    description:
      "Soft-delete a review comment. Requires ifUpdatedAtMatches; returns { error: 'conflict', latest } on stale token. Soft-deleted comments stay readable via list_review_comments({ includeDeleted: true }).",
    inputSchema: {
      type: "object",
      required: ["id", "ifUpdatedAtMatches"],
      properties: {
        id: { type: "string", minLength: 1 },
        ifUpdatedAtMatches: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: "request_review",
    description:
      "Invoke the repo's configured workspace.requestReview hook on a workspace and return the structured suggestions output. Returns { error: 'no-hook' } when nothing is configured, { error: 'hook-failed' | 'timed-out' } on hook failure.",
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      properties: { workspaceId: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    destructive: false,
  },
];
