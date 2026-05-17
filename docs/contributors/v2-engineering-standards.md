# Citadel v2 Engineering Standards

- Use pnpm only. Do not add npm or Yarn lockfiles.
- Keep TypeScript strict and project references green.
- Use Biome for format and lint.
- Run `make check` before claiming readiness.
- Keep core pure: no fs, process, HTTP, React, DB, provider, hook, terminal, runtime, daemon, or MCP implementation imports.
- Keep `apps/web` behind contracts and typed API clients; it must not import daemon internals.
- Non-generated source files should stay under 800 lines.
- Treat lockfile changes as security-sensitive. Review package lifecycle scripts before approving new dependencies.
- Target at least 90% line/statement coverage for core/backend/shared domain modules unless a lower threshold is explicitly documented in the campaign log with rationale.
- Provider-backed features must degrade clearly when provider health is unavailable.
- Workspace cleanup must not delete dirty worktrees unless an explicit force policy is implemented and logged.
- Terminal work is not complete until raw input, control/meta sequences, paste, resize, long output, alternate screen where supported, reconnect, and cross-session isolation are verified.
