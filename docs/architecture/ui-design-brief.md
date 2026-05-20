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

The cockpit is a three-column layout: navigator (left), agent stage (center), inspector (right). Both side columns are independently resizable via drag handles and independently collapsible. Collapsing hides the column entirely while keeping the expand affordance visible. The center column always takes the remaining width. The application shell never page-scrolls; each column owns its own scroll context and the terminal scrolls inside xterm.js.

A slim top bar sits above the cockpit. It contains the product mark on the left, a centered search input that opens the command palette (Cmd+K / Ctrl+K), and the settings entry on the right. The top bar is never the dominant visual mass.

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

The cockpit uses a dark-blue v1-inspired palette: deep navy/slate backgrounds, lighter slate surfaces for panels, a high-contrast cyan/sky accent for selection and primary actions, and explicit health colors (success green, pending amber, danger red, neutral grey) on status icons. Light theme keeps a low-saturation off-white background with the same accent. Color carries information density, not decoration.

Use a restrained, local-tool visual language: small radius (4-8px), compact spacing (4/6/8/12px scale), readable monospace where content is command/diff/terminal oriented, and clear health colors. Icons should support scanning and should come from the configured icon library. Cards are for individual repeated items or framed tools; page sections should stay simple and scannable.

The campaign target remains a shadcn/Tailwind component system. Until that migration is complete, CSS variables and local reusable components must follow the same constraints: accessible controls, stable responsive dimensions, no decorative backgrounds, no nested cards, and no hardcoded color usage inside frequently rendered React components.

## Layout Surfaces

- **Top bar:** Slim horizontal strip. Left: product mark. Center: search input that opens the command palette via click or Cmd+K. Right: settings icon. No other entries belong here.
- **Navigator (left column):** Two primary entries (*Dashboard*, *History*), a subtle divider, then a *Workspaces* header with three icon controls on its right edge - group-by overlay, add-repository overlay, and create-workspace button. Below the header, workspaces appear as slim two-line cards, optionally grouped by repository and/or status (configurable in group-by).
- **Stage (center column):** A workspace's session/chat tabs along the top with a plus button to add a session. The plus button offers `Terminal` plus every healthy agent runtime. Session tabs have editable titles. The selected session takes the rest of the height.
- **Inspector (right column):** Two tabs. *Stats* shows workspace identity, attached Slack/Issue/PR provider icons with dual state, deployed-app chips from repo hooks, and CI/check status. *Git* shows the changed file list with additions/deletions, structured so a future *Human Review* mode can grow inside it.
- **Operations rail (bottom):** Compact footer summarizing operations count and recent activity link.
