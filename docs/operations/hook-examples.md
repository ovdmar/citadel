# Hook examples

Hooks are the extension path for repo-specific behavior. They run as shell commands, receive structured JSON over stdin or env, and (for most events) emit structured JSON on stdout.

This page covers the **deploy hook** and its optional **undeploy hook** companion (per-worktree, used by the cockpit's app/redeploy/undeploy surface) and the **command-hook events** declared in the daemon's config (`workspace.setup`, `workspace.apps`, `workspace.action`, etc.).

The cockpit's empty state in Settings → Repositories → `<repo>` has a "Scaffold with AI" button that launches an agent to author `.citadel/hooks/deploy` for you, primed with the canonical example below. See [install.md](./install.md) for the diagnosis surface (`make doctor`) that flags repos with no hooks bound.

## The deploy hook — `.citadel/hooks/deploy`

Highest-priority resolution: an executable file at `<worktree>/.citadel/hooks/deploy`. Falls back to a per-repo `deployHookCommand` (bash, set from Settings → Repositories → `<repo>` → Deploy hook) when the file is absent.

Contract:

```
$1 = subcommand
  list                 → stdout JSON: {"apps":[{"name":"...", "url":"http://..."}]}
                          must complete in ≤10s; no side effects
  redeploy [name]      → (re)starts the named app, or all apps if no name
                          stdout/stderr stream back to the cockpit operation log
```

Environment provided by Citadel:

- `CITADEL_WORKSPACE_ID` — opaque workspace id
- `CITADEL_WORKSPACE_PATH` — absolute path to the worktree (same as cwd)
- `CITADEL_WORKSPACE_BRANCH`
- `CITADEL_REPO_ID`

### Canonical example (Citadel itself)

The reference implementation lives at `assets/hook-templates/citadel-deploy.sh` (a sanitised, byte-for-byte-regeneratable copy of `.citadel/hooks/deploy` from this very repo). Use it as a starting point.

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${MY_APP:-app}"
WORKTREE="${CITADEL_WORKSPACE_PATH:-$(pwd)}"

# Replace with your own port/URL derivation.
PORT=3000
HOST=127.0.0.1

case "${1:-}" in
  list)
    printf '{"apps":[{"name":"%s","url":"http://%s:%d"}]}\n' "$APP_NAME" "$HOST" "$PORT"
    ;;
  redeploy)
    # Whatever your repo does to restart the app. Stream output back.
    make dev-deploy "${2:-}"
    ;;
  *)
    echo "unknown subcommand: ${1:-<none>}" >&2
    exit 2
    ;;
esac
```

Make it executable:

```bash
chmod +x .citadel/hooks/deploy
```

Verify:

```bash
./.citadel/hooks/deploy list | jq .
```

## The undeploy hook — `.citadel/hooks/undeploy`

Optional companion to the deploy hook. When an executable file exists at `<worktree>/.citadel/hooks/undeploy`, the cockpit shows an X beside the reload control for apps whose probe status is `deployed`. With multiple deployed apps, the panel header also shows an undeploy-all X beside the redeploy-all button.

Contract:

```
$1 = app name, optional
  omitted       → stop all deployed apps exposed by the deploy hook
  app-name      → stop only that named app
```

Environment is the same as the deploy hook. stdout/stderr stream back to the cockpit operation log.

Minimal example:

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${1:-all}" in
  web|all) make stop-web ;;
  *) echo "unknown app: $1" >&2; exit 2 ;;
esac
```

Make it executable:

```bash
chmod +x .citadel/hooks/undeploy
```

## Command hooks (config-declared)

Beyond the per-worktree deploy hook, Citadel runs declared command hooks for workspace lifecycle and per-workspace data discovery. These live in the daemon's config (`~/.local/share/citadel/citadel.config.json`) and are bound to repos via the repo settings page.

### Events

| Event | Purpose | Blocking by default? |
|---|---|---|
| `workspace.setup` | Run once after a workspace's worktree is created (clone deps, copy `.env`, etc.) | yes |
| `workspace.teardown` | Run once before workspace removal (purge state, deregister) | yes |
| `workspace.apps` | List apps/links for this workspace (alternative to `.citadel/hooks/deploy`) | no |
| `workspace.action` | Execute a repo-declared action triggered from the cockpit | no |
| `workspace.created` | Notification — workspace was created | no |
| `workspace.archived` | Notification — workspace was archived | no |
| `workspace.removed` | Notification — workspace was removed | no |
| `agent.started` | Notification — an agent session started on a workspace | no |

### Input shape (stdin JSON)

```json
{
  "event": "workspace.setup",
  "workspace": { "id": "ws_...", "path": "/abs/path", "branch": "...", "repoId": "..." },
  "repo":      { "id": "...", "name": "...", "rootPath": "/abs/path" },
  "provider":  { ... }  // for events that carry provider context
}
```

### Output shape (stdout JSON, for non-notification events)

```json
{
  "links":   [{ "label": "Preview", "url": "https://...", "kind": "preview" }],
  "actions": [{ "id": "redeploy", "label": "Redeploy", "url": "https://..." }],
  "metadata": { "environment": "staging" }
}
```

Exit code: `0` = success. Non-zero for blocking events (setup/teardown) marks the workspace operation failed.

### Minimal `workspace.setup` stub

```bash
#!/usr/bin/env bash
set -euo pipefail
# read context: payload=$(cat)
# do setup work
exit 0
```

Bind it via the daemon config:

```jsonc
{
  "hooks": [
    {
      "id": "my-repo-setup",
      "kind": "command",
      "event": "workspace.setup",
      "command": "/abs/path/to/setup.sh",
      "args": []
    }
  ],
  "repoDefaults": {
    "setupHookIds": ["my-repo-setup"]
  }
}
```

### Minimal `workspace.apps` stub

```bash
#!/usr/bin/env bash
payload=$(cat)
workspace_path=$(echo "$payload" | jq -r '.workspace.path')
# inspect $workspace_path, decide what apps are available
jq -n --arg url "http://localhost:8080" '{ apps: [{ name: "web", url: $url }] }'
```

### Minimal `workspace.action` stub

```bash
#!/usr/bin/env bash
payload=$(cat)
action_id=$(echo "$payload" | jq -r '.action.id')
case "$action_id" in
  refresh-cache) make refresh-cache ;;
  *) echo "unknown action: $action_id" >&2; exit 2 ;;
esac
```

## Hook diagnostics

Settings → Repositories → `<repo>` → Hooks renders a diagnostics panel for each bound hook: command, cwd, blocking?, last run, validation status, errors. Use it when a hook silently misbehaves.

## When in doubt: AI-scaffold

If you're staring at "No hooks bound to this repo" and don't know where to start, the cockpit's "Scaffold with AI" button (on the same page) creates a fresh worktree on branch `hook-scaffold-<ts>`, starts a Claude Code session with the canonical template + your repo's context primed, and tells the agent to write + validate `.citadel/hooks/deploy`. Subsequent clicks reuse the in-flight workspace instead of spawning duplicates.

Scaffold workspaces follow the standard lifecycle — commit, open a PR, merge. Citadel does not auto-delete them.
