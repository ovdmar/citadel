import { z } from "zod";
import { IdSchema } from "./ids.js";

// Hook-related schemas are colocated here so packages/contracts/index.ts
// stays under the 800-line cap. Re-exports happen via index.ts.

export const HookLinkSchema = z.object({
  label: z.string().min(1).max(80),
  url: z.string().url(),
  kind: z.enum(["preview", "deploy", "docs", "external"]).default("external"),
});

export const HookApplicationSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  kind: z.enum(["preview", "deployment", "service", "docs", "external"]).default("service"),
  url: z.string().url().nullable().default(null),
  environment: z.string().max(80).nullable().default(null),
  status: z.enum(["healthy", "degraded", "unavailable", "unknown"]).default("unknown"),
  version: z.string().max(120).nullable().default(null),
  commit: z.string().max(80).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  metadata: z.record(z.unknown()).default({}),
});

export const HookActionSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(80),
  description: z.string().max(200).nullable().default(null),
  url: z.string().url().nullable().default(null),
  kind: z.enum(["redeploy", "restart", "logs", "open", "custom"]).optional(),
  safety: z.enum(["safe", "confirm", "destructive"]).optional(),
  executable: z.boolean().optional(),
  hookId: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const HookOutputSchema = z
  .object({
    applications: z.array(HookApplicationSchema).max(30).optional(),
    links: z.array(HookLinkSchema).max(20).default([]),
    actions: z.array(HookActionSchema).max(20).default([]),
    metadata: z.record(z.unknown()).default({}),
  })
  .default({ links: [], actions: [], metadata: {} });

export const HookDiagnosticSchema = z.object({
  hookId: z.string(),
  event: z.string(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  blocking: z.boolean(),
  enabled: z.boolean(),
  validationStatus: z.enum(["valid", "invalid"]),
  validationErrors: z.array(z.string()).default([]),
  lastRunAt: z.string().nullable().default(null),
  durationMs: z.number().int().nullable().default(null),
  exitStatus: z.number().int().nullable().default(null),
  outputSummary: z.string().nullable().default(null),
  structuredPayload: HookOutputSchema.nullable().default(null),
});

// HookEventSchema is the canonical list of events that can fire a hook.
// Lives in @citadel/contracts (not @citadel/config) so packages that consume
// the event identifier — @citadel/hooks discovery, @citadel/db rows — can
// import it without pulling in the full config surface. @citadel/config
// re-exports it for backcompat with consumers that already import from there.
//
// `deploy` is deliberately NOT a HookEvent — it's a file-name convention for
// the special-case deploy hook at `.citadel/hooks/deploy` (a file, not an
// event folder). File-based discovery iterates only over HookEvent values, so
// `.citadel/hooks/deploy/` is never read as an event folder.
export const HookEventSchema = z.enum([
  "workspace.setup",
  "workspace.teardown",
  "workspace.apps",
  "workspace.action",
  "workspace.created",
  "workspace.archived",
  "workspace.removed",
  "agent.started",
  "pr.merge",
  "merge.conflict.detected",
  "review.requested",
]);

export type HookEvent = z.infer<typeof HookEventSchema>;

// Frontmatter for a file-based `.agent` hook. Parsed from the optional
// `---`-fenced block at the top of a `.agent` file. `.strict()` rejects
// unknown keys (including reserved `target`, `blocking`, and `model`) with a
// clear diagnostic — forward-compat: once a key is shipped, it's part of the
// contract; once a name is rejected, it can be added later without breaking
// existing files.
//
// `model` is reserved (NOT shipped): citadel's CreateAgentSessionInput has no
// per-launch model field today — model selection is handled via the runtime's
// args. Accepting `model:` here without plumbing it through would silently
// drop the value. When createAgentSession learns about model selection,
// `.strict()` can be relaxed.
export const AgentHookFrontmatterSchema = z
  .object({
    runtime: z.string().min(1).optional(),
    // displayName is the agent session's user-visible label (NOT the tmux
    // session id, which is generated separately by createAgentSession).
    // Charset is restricted to keep diagnostics readable and avoid surprises
    // in UI rendering.
    displayName: z
      .string()
      .regex(/^[A-Za-z0-9 _:-]{1,80}$/, "displayName must match ^[A-Za-z0-9 _:-]{1,80}$")
      .optional(),
  })
  .strict();

export type AgentHookFrontmatter = z.infer<typeof AgentHookFrontmatterSchema>;
