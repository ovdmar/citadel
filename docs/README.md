# Citadel Docs Map

This directory separates product and engineering documentation from process artifacts.

## Product And Architecture

- [User Journeys](architecture/user-journeys.md) - operator workflows and UX priorities.
- [UI Design Brief](architecture/ui-design-brief.md) - density, layout, mobile, copy, and visual-system rules.
- [Citadel v2 Architecture](architecture/citadel-v2-architecture.md) - package boundaries, persistence, providers, terminal model, and deployment.
- [Technical Decisions](architecture/technical-decisions.md) - why the project uses a local daemon, SQLite, Zod contracts, tmux/PTY terminals, and provider adapters.
- [Product Specs](../specs/README.md) - state-based product targets.

## Operations

- [Install](operations/install.md) - long-term systemd install and upgrade path.
- [Runbook](operations/runbook.md) - development commands, MCP status, terminal diagnostics, and operational checks.
- [Worktree Development](operations/worktree-development.md) - how multiple local worktrees run without port/state collisions.
- [Config Reference](operations/config-reference.md) - config shape, providers, hooks, runtimes, MCP, and terminal gateway behavior.
- [Hook Examples](operations/hook-examples.md) - repo hook patterns and examples.

## Engineering

- [Engineering Standards](contributors/v2-engineering-standards.md) - checks, code organization, testing, and review expectations.
- `e2e/` - Playwright user-flow regression coverage.
- `scripts/checks/` - architecture, size, and dependency-policy gates.

## Process Artifacts

These files are intentionally retained but are not the primary product narrative:

- `.agents/` - local SDLC skill/profile configuration used by automation in this workspace.
- `CLAUDE.md` - quick reference for agent sessions working in the repo.
- `docs/campaigns/` - implementation logs, traceability notes, and screenshot artifacts from development campaigns.
- `plans/` - older technical plans retained for context.

When reviewing Citadel as a project, start with the product, architecture, operations, and engineering sections above. Use the process artifacts only when you need historical context for why a change was made.
