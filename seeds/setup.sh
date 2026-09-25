#!/usr/bin/env bash
# Materializes a mock git repo + demo worktrees under <checkout>/.citadel/ so
# the seeded cockpit has real, on-disk paths to point its workspace rows at.
# Idempotent — re-running is a no-op if the repo already exists. Pair with
# seeds/seed.sql, which inserts rows referencing these paths.
set -euo pipefail

CHECKOUT="${1:?usage: setup.sh <checkout-absolute-path>}"
REPO="$CHECKOUT/.citadel/mock-repo"
WT_DIR="$CHECKOUT/.citadel/mock-worktrees"
WT_FEATURE="$WT_DIR/demo-feature"
WT_BACKLOG="$WT_DIR/demo-backlog"
WT_STRUCTURED_ROOT="$WT_DIR/structured-delivery"
WT_REVIEW="$WT_STRUCTURED_ROOT/review-ready"
WT_BLOCKED="$WT_STRUCTURED_ROOT/blocked-checks"

if [ ! -d "$REPO/.git" ]; then
  echo "→ Initializing mock repo at $REPO"
  mkdir -p "$REPO"
  cd "$REPO"
  git init -q -b main
  git config user.email "seed@citadel.local"
  git config user.name "Citadel Seed"

  cat > README.md <<'EOF'
# Citadel mock repo

Hand-crafted fixture used by `make seed` so the cockpit has data to render
during worktree development. Not real code. Regenerate with `make seed-reset`.
EOF

  mkdir -p src
  cat > src/index.ts <<'EOF'
export function greet(name: string): string {
  return `Hello, ${name}!`;
}

console.log(greet("citadel"));
EOF

  git add -A
  git commit -q -m "Initial mock repo"
else
  echo "✓ Mock repo already at $REPO"
  cd "$REPO"
  git config user.email "seed@citadel.local"
  git config user.name "Citadel Seed"
fi

mkdir -p "$WT_DIR"

ensure_worktree() {
  local branch="$1"
  local target="$2"
  if [ -e "$target/.git" ] || [ -f "$target/.git" ]; then
    echo "✓ Worktree already at $target"
    return
  fi
  if git show-ref --verify --quiet "refs/heads/$branch"; then
    git worktree add -q "$target" "$branch"
  else
    git worktree add -q -b "$branch" "$target"
  fi
}

ensure_worktree "feature/demo-feature" "$WT_FEATURE"
(
  cd "$WT_FEATURE"
  if [ ! -f src/version.ts ]; then
    cat > src/version.ts <<'EOF'
export const VERSION = "1.0.0";
EOF
    git add -A
    git commit -q -m "Add version export"
  fi
)

# demo-backlog stays at the initial commit: represents a brand-new workspace
# with no changes yet.
ensure_worktree "feature/demo-backlog" "$WT_BACKLOG"

mkdir -p "$WT_STRUCTURED_ROOT"
mkdir -p "$WT_STRUCTURED_ROOT/.citadel"
mkdir -p "$WT_STRUCTURED_ROOT/.citadel/plans"
cat > "$WT_STRUCTURED_ROOT/.citadel/workspace.json" <<'EOF'
{
  "version": 1,
  "mode": "structured",
  "name": "structured-delivery",
  "purpose": "Seeded QA fixture for structured agents orchestration"
}
EOF
cat > "$WT_STRUCTURED_ROOT/.citadel/plans/approved-plan.md" <<'EOF'
Activate the /implement-task skill first.

# Structured Delivery Demo Plan

## Delivery Units

1. Review-ready checkout: demonstrate green PR facts, a current review artifact,
   and ready-for-human-review gate state.
2. Blocked checkout: demonstrate failing check facts plus a blocking plan
   deviation.

## Dependencies / Timeline

The review-ready checkout can be inspected immediately. The blocked checkout
needs CI failure triage and a deviation response before review.

## Manager Handoff

Manager should notify the operator about the ready checkout and keep the
blocked checkout out of human review until the deviation is resolved.

## Plan Version Notes

Seed fixture version for QA of structured agents orchestration.
EOF
ensure_worktree "feature/structured-review" "$WT_REVIEW"
(
  cd "$WT_REVIEW"
  if [ ! -f docs/review-ready.md ]; then
    mkdir -p docs
    cat > docs/review-ready.md <<'EOF'
# Review-ready structured checkout

This checkout is seeded with a green intended PR, a current review artifact,
and a ready-for-human-review gate so the structured manager surfaces have
something concrete to inspect.
EOF
    git add -A
    git commit -q -m "Add review-ready structured fixture"
  fi
)

ensure_worktree "feature/structured-blocked" "$WT_BLOCKED"
(
  cd "$WT_BLOCKED"
  if [ ! -f docs/blocked.md ]; then
    mkdir -p docs
    cat > docs/blocked.md <<'EOF'
# Blocked structured checkout

This checkout is seeded with failing checks and an open plan deviation so QA can
verify blocked checkout states without having to create one manually.
EOF
    git add -A
    git commit -q -m "Add blocked structured fixture"
  fi
)

echo "✓ Mock repo + 4 worktrees ready under $CHECKOUT/.citadel/"
