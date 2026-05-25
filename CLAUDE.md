# Citadel — agent quick reference

Two commands you ever run:

| Command | Audience | What it does |
|---|---|---|
| `make install` | Users (or your own devbox) | Install/refresh the long-term systemd `citadel.service` to supervise *this* checkout. Idempotent. |
| `make deploy` | Devs working on Citadel | Start a worktree-isolated HMR dev stack (daemon + vite, detached). Same command the cockpit's Redeploy chip invokes. Self-contained — doesn't depend on `make install`. |

Plus the lifecycle helpers: `make setup` (pnpm install), `make stop`, `make logs`.

## Mental model

Every command is scoped to the current checkout. There is no implicit "main vs worktree" dispatch. The daemon binds a derived port (`4110 + cksum(absolute_path) % 100`, range 4110–4209), vite binds another derived port (`5210–5309`), and both store their state in `<checkout>/.citadel/`. Several worktrees can run side-by-side; none of them touch the systemd long-term service.

`.citadel/dev.json` is the source of truth for which port a worktree is on (the daemon walks past EADDRINUSE and persists the chosen port). The Makefile and the deploy hook both read it first; the hook advertises the vite cockpit URL (HMR — refreshes on source edits without re-deploying).

## When something looks wrong

- "The cockpit shows a 404 for a route I just added" → you're on the wrong URL. Each `make deploy` prints its cockpit URL on success; `:4010` is the systemd long-term daemon (different branch), not your worktree.
- "Port already in use" → `make stop` (kills the prior dev stack recorded in `.citadel/logs/daemon.pid`).

See `docs/operations/worktree-development.md` for the full model.

## Conventions for agents

- Do not invoke `pkill -f node` or anything that could take down the user's systemd daemon.
- Do not edit files under `/home/jonsnow/Workspace/citadel/` (the main checkout the systemd unit may point at) from this worktree.
- When asked to "redeploy" / "restart", run `make deploy` (it stops the previous stack and starts fresh).

## Repo hook files

Hooks tracked in the repo live under `.citadel/hooks/`:

- `.citadel/hooks/deploy` — the special-case deploy hook (a file). Implements the `list`/`redeploy` subcommand contract; see `packages/hooks/src/deploy.ts`. Untouched by the event-folder discovery below.
- `.citadel/hooks/<event>/<name>.sh` — a bash hook that fires on the named event. Must be executable; receives JSON payload on stdin; stdout parsed as structured `HookOutput`.
- `.citadel/hooks/<event>/<name>.agent` — an agent-prompt hook. Optional `---`-fenced frontmatter (`runtime`, `model`, `displayName`); body is `{{a.b.c}}`-templated against the payload, then sent as the seed prompt to a fresh agent session. `.agent` is NOT allowed under `agent.started/` (would loop).

Per-event ordering: config-defined hooks run first (in the order listed in `repoDefaults.*HookIds`), then file hooks (lexicographic by filename). Multiple file hooks per event are fine; use a numeric prefix (`10-bootstrap.sh`, `20-notify.agent`) to control order.

**Security note:** files in `.citadel/hooks/` execute on every relevant event in every workspace. Review them in PRs like any other privileged code.

If `.citadel/hooks/deploy` somehow becomes a directory rather than a file, the special-case deploy hook silently disables (`inspectHookFile` requires a file). Don't put event-folder hooks under a name that collides with the special-case file.
