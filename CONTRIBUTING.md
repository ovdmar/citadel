# Contributing

Citadel is a local-first TypeScript monorepo. Contributions should preserve the package boundaries, local-state safety, and operator-focused UI model described in the docs.

## Start Here

1. Read [README.md](README.md) for the product and architecture overview.
2. Read [docs/README.md](docs/README.md) for the docs map.
3. Read [docs/contributors/v2-engineering-standards.md](docs/contributors/v2-engineering-standards.md) before changing code.

## Development Loop

```bash
make setup
make deploy
```

`make deploy` starts a worktree-scoped daemon + Vite stack and prints the cockpit URL. It keeps local development separate from the long-term systemd install.

## Required Checks

Run the focused tests for your change, then run:

```bash
make check
```

For UI or workflow changes, also run the relevant Playwright spec:

```bash
pnpm e2e:isolated --project=desktop e2e/<spec>.spec.ts
```

Use the isolated wrappers when possible. They allocate temporary state and avoid writing into the operator's real Citadel database/config.

## Architecture Rules

- `apps/web` imports shared contracts, not daemon internals.
- `packages/core` stays pure and does not import implementation packages.
- cleanup paths must not delete dirty worktrees without explicit force behavior.
- provider-backed features must degrade clearly when provider health is unavailable.
- dependency changes require lockfile review and must pass dependency policy.
- UI changes should stay dense, accessible, keyboard-friendly, and consistent with the local design-system tokens/components.

## Documentation

Update docs when changing product behavior, install/runtime behavior, package boundaries, config shape, or operator-visible workflows.

Use product-facing docs for product explanations. Keep agent/process notes in the process-artifact areas documented in [docs/README.md](docs/README.md).
