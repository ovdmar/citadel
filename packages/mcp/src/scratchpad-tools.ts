import type { McpToolDefinition } from "./index.js";

export const SCRATCHPAD_TOOL_NAMES = [
  "read_scratchpad",
  "write_scratchpad",
  "append_scratchpad",
  "list_blocks",
  "add_block",
  "update_block",
  "delete_block",
  "fuzzy_search_scratchpad",
  "refine_scratchpad",
] as const;

export type ScratchpadToolName = (typeof SCRATCHPAD_TOOL_NAMES)[number];

export const SCRATCHPAD_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "read_scratchpad",
    description:
      "Read the user's scratchpad. The user notes thoughts and TODOs here for orchestrator agents to pick up. Returns { content, updatedAt }. The file is fenced markdown (block-based); see list_blocks for structured access.",
    inputSchema: { type: "object", additionalProperties: false },
    destructive: false,
  },
  {
    name: "write_scratchpad",
    description:
      "Overwrite the scratchpad. Replaces all existing content. Returns the new { content, updatedAt }. Prefer add_block / update_block for fine-grained edits or append_scratchpad to add a note without clobbering.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string" } },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "append_scratchpad",
    description:
      "Creates a new block (UUID-fenced) at the end of the scratchpad with the given content. Each call produces exactly one block — to add multiple related lines in a single block, pass them together in one call with embedded newlines. Returns { content, updatedAt }.",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: { content: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "list_blocks",
    description:
      "List the scratchpad's blocks. Returns { blocks: [{ id, text, createdAt, updatedAt }] } where text is the inner markdown (no fences) and timestamps are best-effort (derived from version history; may be aliased within a same-source 60s coalesce window).",
    inputSchema: { type: "object", additionalProperties: false },
    destructive: false,
  },
  {
    name: "add_block",
    description:
      "Append a new block (or insert after a given block) with the supplied text. Position defaults to 'end'; pass { afterId } to insert after a specific block. Returns { block, content, updatedAt } or { error: 'block_not_found' | 'text_required' | 'scratchpad_too_large' }.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1 },
        position: {
          oneOf: [
            { type: "string", enum: ["end"] },
            {
              type: "object",
              required: ["afterId"],
              properties: { afterId: { type: "string", minLength: 1 } },
              additionalProperties: false,
            },
          ],
        },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "update_block",
    description:
      "Overwrite a block's text by id, preserving its UUID. Passing empty/whitespace-only text deletes the block. Returns { block, content, updatedAt } (update) or { content, updatedAt } (delete) or { error: 'block_not_found' | 'scratchpad_too_large' }.",
    inputSchema: {
      type: "object",
      required: ["id", "text"],
      properties: {
        id: { type: "string", minLength: 1 },
        text: { type: "string" },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "delete_block",
    description: "Delete a block by id. Returns { content, updatedAt } or { error: 'block_not_found' }.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", minLength: 1 } },
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: "fuzzy_search_scratchpad",
    description:
      "Fuzzy-search the scratchpad's blocks by text content. Returns { matches: [{ block, score, matches: [{ indices: [[start, end], ...] }] }] } ordered by descending relevance (lower score = better match). Limit defaults to 20, max 50. Matches are character indices into the block's text. Shares ranking with the cockpit's floating searchbar so UI and MCP results stay consistent.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
  {
    name: "refine_scratchpad",
    description:
      "Launch an agent in a fresh workspace to refine (deduplicate, group, tidy) the scratchpad. Uses the user's saved 'refine-scratchpad' Citadel Action prompt by default; override with `prompt` for this run only. Pass `repoId` or `repoName` to pick the host repo (defaults to the most-recently-active repo on the daemon). Returns the discriminated union { ok: true, workspaceId, sessionId, warning? } | { ok: false, error: 'runtime_unavailable'|'repo_required'|'launch_failed', detail, workspaceId? }. The agent is expected to skip blocks tagged `in-progress`; if the resolved prompt omits that substring the response includes a soft `warning` field.",
    inputSchema: {
      type: "object",
      properties: {
        repoId: { type: "string", minLength: 1 },
        repoName: { type: "string", minLength: 1 },
        prompt: { type: "string", minLength: 1 },
      },
      additionalProperties: false,
    },
    destructive: false,
  },
];
