import { z } from "zod";

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
// unknown keys (including reserved `target` and `blocking`) with a clear
// diagnostic — forward-compat: once a key is shipped, it's part of the
// contract; once a name is rejected, it can be added later without breaking
// existing files.
export const AgentHookFrontmatterSchema = z
  .object({
    runtime: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
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
