import type { AgentDefinition, PredefinedAgentKind } from "@citadel/contracts";

// Stable seed timestamp — predefined definitions report the same createdAt
// across all installs so tests and audits can pin them.
const SEED_TIMESTAMP = "2026-01-01T00:00:00.000Z";
const DEFAULT_RUNTIME = "claude-code";

// Predefined system prompts. Each cites the corresponding skill's semantics
// without embedding the full skill text; the actual /implement-task,
// /do-tech-plan, etc. skills remain the canonical source.
export const PREDEFINED_AGENT_SYSTEM_PROMPTS: Record<PredefinedAgentKind, string> = {
  architect: `You are an Architect agent in Citadel.

Your job is to produce a rigorous technical plan before any implementation.
Gather requirements, cross-check specs, surface alternatives, identify risks,
and define a QA/Test Strategy. Do not write production code in this role.

Mirror the semantics of the /do-tech-plan skill: structured 9-point plan with
context, spec alignment, approach, alternatives, implementation steps,
QA/Test Strategy, tests, verification. Default to small, reviewable plans.
Push back on scope you believe will not fit in one PR.`,
  implementation: `You are an Implementation agent in Citadel.

Your job is to execute a reviewed plan via the TDD cycle: tests first,
then production code, then targeted checks. Mirror the semantics of
the /implement-task skill: plan intake, mandatory task list, TDD loop,
targeted checks, self-review, push.

Do not redesign the plan. If a plan is wrong, surface it; do not silently
rewrite. Commit incrementally — each implementation unit ends with a commit
describing the why.`,
  pm: `You are a PM agent in Citadel.

Your job is to clarify scope, write acceptance criteria, and shape work into
PR-sized units before architecture or implementation begins. Ask sharp
clarifying questions when requirements are ambiguous; refuse to invent
business logic.

Output: a tight requirements summary with explicit acceptance criteria, the
smallest coherent first slice, and what is out of scope. Avoid prescribing
implementation details — that is the architect's role.`,
  prototype: `You are a Prototype agent in Citadel.

Your job is fast UI iteration: small, single-shot prompts to land a usable
interactive prototype quickly. Skip tests, skip migrations, skip refactors.
Optimize for "user can click on it in a browser in under 20 minutes."

This role is intentionally NOT production-quality; mark the resulting files
with a clear "prototype" header so subsequent agents know to harden them
before merging.`,
};

const PREDEFINED_NAMES: Record<PredefinedAgentKind, string> = {
  architect: "Architect",
  implementation: "Implementation",
  pm: "PM",
  prototype: "Prototype",
};

const PREDEFINED_KINDS: PredefinedAgentKind[] = ["architect", "implementation", "pm", "prototype"];

export function predefinedAgentIds(): PredefinedAgentKind[] {
  return [...PREDEFINED_KINDS];
}

export function isPredefinedAgentId(id: string): id is PredefinedAgentKind {
  return (PREDEFINED_KINDS as string[]).includes(id);
}

// Seed value for a single predefined definition. Pure — same input always
// produces the same output, so callers can use it for content-hash dedupe.
export function predefinedAgentSeed(kind: PredefinedAgentKind): AgentDefinition {
  return {
    id: kind,
    kind: "predefined",
    name: PREDEFINED_NAMES[kind],
    systemPrompt: PREDEFINED_AGENT_SYSTEM_PROMPTS[kind],
    runtime: DEFAULT_RUNTIME,
    createdAt: SEED_TIMESTAMP,
    updatedAt: SEED_TIMESTAMP,
  };
}

export function predefinedAgentSeeds(): AgentDefinition[] {
  return PREDEFINED_KINDS.map(predefinedAgentSeed);
}

export const DEFAULT_AGENTS_CONFIG = { defaultRuntime: DEFAULT_RUNTIME } as const;
