#!/usr/bin/env bash
# Materializes a mock git repo + two worktrees under <checkout>/.citadel/ so
# the seeded cockpit has real, on-disk paths to point its workspace rows at.
# Idempotent — re-running is a no-op if the repo already exists. Pair with
# seeds/seed.sql, which inserts rows referencing these paths.
set -euo pipefail

CHECKOUT="${1:?usage: setup.sh <checkout-absolute-path>}"
REPO="$CHECKOUT/.citadel/mock-repo"
WT_DIR="$CHECKOUT/.citadel/mock-worktrees"
WT_FEATURE="$WT_DIR/demo-feature"
WT_BACKLOG="$WT_DIR/demo-backlog"

if [ -d "$REPO/.git" ]; then
  echo "✓ Mock repo already at $REPO"
  exit 0
fi

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

mkdir -p "$WT_DIR"

git worktree add -q -b feature/demo-feature "$WT_FEATURE"
(
  cd "$WT_FEATURE"
  cat > src/version.ts <<'EOF'
export const VERSION = "1.0.0";
EOF
  git add -A
  git commit -q -m "Add version export"
)

# demo-backlog stays at the initial commit — represents a brand-new workspace
# with no changes yet.
git worktree add -q -b feature/demo-backlog "$WT_BACKLOG"

echo "✓ Mock repo + 2 worktrees ready under $CHECKOUT/.citadel/"
