# Citadel v2 UI Design Brief

## Users

Citadel is for operators who manage multiple local workspaces and agent runtimes during software delivery. The primary user is already comfortable with git, terminals, provider CLIs, and local development. The UI should reduce context switching and surface workflow state without hiding the underlying repo/runtime reality.

## Primary Workflows

- Register a local repository and confirm provider/runtime health.
- Create a workspace from scratch, a PR, or an issue-backed task.
- Start one or more configured agent runtimes in a workspace.
- Monitor workspace lifecycle, operations, activity, provider status, and terminal state.
- Inspect read-only diffs before cleanup or handoff.
- Adjust local config for providers, hooks, runtimes, MCP, and cleanup policy.

## Information Hierarchy

The cockpit starts with local operational state: repos, workspaces, sessions, and MCP. Workspace state comes before provider detail. Provider detail explains availability and action readiness, not raw command output. Terminal and diff surfaces are task tools, not decorative previews.

Settings starts with local config and setup status, then provider health, runtimes, and MCP. Configuration errors must be field-specific where possible because bad config can block startup or workspace operations.

## Density And Navigation

Citadel should feel like a compact operations console. Use short headings, stable panels, compact rows, and dense controls. Avoid landing-page composition, oversized hero areas, marketing copy, ornamental gradients, and nested cards. Navigation is shallow: cockpit and settings first, with workspace detail embedded in the cockpit until the model genuinely requires deeper routing.

## Interaction Principles

- Prefer direct controls over explanatory text.
- Disable provider-backed actions when provider health is not healthy.
- Show loading, empty, degraded, and error states in the same surface where the user would act.
- Keep destructive cleanup explicit and blocked by dirty status unless force policy permits it.
- Preserve terminal sessions across view changes by relying on tmux identity and xterm.js, not React-rendered scrollback.
- Keep keyboard-accessible semantic controls as the baseline.

## Mobile Behavior

Mobile is for monitoring, navigation, provider/status inspection, and light actions. It is not the primary surface for sustained terminal work. Panels must stack without overlapping controls, and labels must wrap rather than overflow.

## Performance Principles

The expected first-campaign load is roughly 10-12 active workspaces per repo, multiple sessions, and long terminal buffers. Workspace switching should reuse server-state cache and avoid full-page reloads. Terminal scrollback must remain inside xterm.js or equivalent terminal primitives rather than React DOM.

## Product Copy Filter

Visible UI copy must help the operator understand state, decide, or act. Do not show implementation instructions, Jira task wording, prompt text, planning metadata, raw provider debug dumps, OpenClaw-specific labels, or raw internal enum names unless transformed into product-level concepts.

Preferred product terms:

- `Provider health`, not raw CLI diagnostics as headings.
- `Issue tracker`, `version control`, and `checks` when the concept is provider-agnostic.
- `Workspace`, `runtime`, `session`, `operation`, and `activity` for Citadel concepts.
- `Unavailable`, `degraded`, `ready`, `failed`, and `archived` only when they describe current operational state.

## Visual System

Use a restrained, local-tool visual language: neutral surfaces, small radius, compact spacing, readable monospace where content is command/diff/terminal oriented, and clear health colors. Icons should support scanning and should come from the configured icon library. Cards are for individual repeated items or framed tools; page sections should stay simple and scannable.

The campaign target remains a shadcn/Tailwind component system. Until that migration is complete, CSS variables and local reusable components must follow the same constraints: accessible controls, stable responsive dimensions, no decorative backgrounds, no nested cards, and no hardcoded color usage inside frequently rendered React components.
