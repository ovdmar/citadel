# Create-pr extension — Citadel

## PR creation

Use `gh pr create` with these defaults:

```bash
gh pr create \
  --base main \
  --title "<conventional-commit-style>" \
  --body "$(cat <<'EOF'
## Summary
<1-3 bullets — what changes and why>

## Plan
<link to .agents/plans/<feature-name>.md if present, else "Inline / trivial">

## Test plan
- [ ] `make check` passes locally
- [ ] `pnpm e2e` passes locally (if E2E surface changed)
- [ ] `pnpm smoke` passes (if daemon HTTP surface changed)
- [ ] Manual QA per the How-to-QA section below

🤖 Generated with Claude Code
EOF
)"
```

**Title format.** Conventional commits, matching the existing repo style:
- `feat(<scope>): <short imperative>` — new functionality
- `fix(<scope>): <short imperative>` — bug fix
- `chore(<scope>): <short imperative>` — tooling/deps/non-functional
- `docs(<scope>): <short imperative>` — docs-only
- `refactor(<scope>): <short imperative>` — restructure without behavior change

Scopes seen in main: `terminal`, `theme`, `deploy-hook`, plus per-package or per-app scopes.

**Labels and reviewers.** No automated label policy in this repo; do not set `--label` unless the user asks. No automated reviewer assignment.

**Draft vs. ready.** Default to ready. Use `--draft` only when the user explicitly requests it.

## Preview links

Citadel does NOT have a managed preview infrastructure (no Vercel / Netlify / per-PR ephemeral deploys). Skip preview-link posting entirely.

If a `make dev status` shows a running local daemon for this worktree, the dev URL is `http://localhost:${DAEMON_PORT}` (default 4010). Mention this in the How-to-QA section rather than posting it as a PR comment, since it's only reachable from the developer's machine.

## Verification commands

Same content as `.agents/skills/extensions/implement-task.md` under "Targeted check commands". During the CI fix loop, use the same scope → command mapping. `make check` is the comprehensive local gate; prefer running it first on any non-trivial CI failure.

## Spec layout

Same glob → spec mapping as `.agents/skills/extensions/review-pr.md` under "Spec mappings". Spec verification in Section 2 reads any spec that maps to a changed file, and updates implementation-status markers if the diff completes (or partially completes) a spec item.

## How to QA

Use this template for the completion report's How-to-QA section:

```
### How to QA

1. Pull the branch: `git checkout <branch-name>`
2. Install: `pnpm install`
3. Full check: `make check`
4. Start the daemon + web in dev mode: `pnpm dev`
   - Daemon: http://localhost:4010 (or the worktree's resolved port)
   - Web cockpit: http://localhost:5173

[Then 2-3 bullet points specific to this change. Examples:
- Open the cockpit, navigate to a workspace, verify the new "<feature>" button appears in the actions menu
- Trigger <action>, observe that <expected behavior>
- For daemon-only changes: `make smoke` to exercise the affected endpoint]

For E2E coverage (recommended for UI changes):
- `pnpm exec playwright test e2e/<spec-name>.spec.ts` to run only the relevant spec
- `pnpm e2e` to run the full suite
```

If the change touches `packages/db/src/index.ts` schema, add:

```
**Schema-affecting change.** To test against a pre-existing database:
1. Stop any running daemon: `make stop`
2. Save your existing DB: `cp $HOME/.citadel/citadel.db /tmp/citadel-before.db`
3. Start the daemon: `pnpm dev:daemon`
4. Verify the schema migration applied cleanly and existing data is preserved.
```

## Postponement

Deferral marker: `// TODO(create-pr): <description>` placed at the exact location.

For significant deferred items, append a bullet to the relevant log under `docs/campaigns/` with: PR number, file:line, description, why deferred. Do not file GitHub issues automatically.

## Transcript audit

Runtime: Claude Code transcripts live at `~/.claude/projects/-<cwd-with-slashes-as-dashes>/*.jsonl`. To resolve for the current workspace:

```bash
CWD_KEY=$(pwd | sed 's|/|-|g')
TRANSCRIPT_DIR="$HOME/.claude/projects/${CWD_KEY}"
TRANSCRIPT=$(ls -t "$TRANSCRIPT_DIR"/*.jsonl 2>/dev/null | head -1)
```

If `$TRANSCRIPT` is empty, the audit is skipped with a note ("No Claude Code transcript found for this workspace — likely run in a different runtime, or transcripts have been cleared.").

For Codex CLI runs: there is no equivalent transcript format the bundled parser supports. Skip the audit when running under Codex; note in the completion report.
