# Citadel — agent quick reference

This is a Citadel checkout, possibly a git worktree. Every local command in
this tree is scoped to *this* checkout — its own daemon port, its own SQLite,
its own logs. Worktrees never talk to each other and never touch the
systemd-supervised long-term service.

## Commands

| Command | What it does |
|---|---|
| `make deploy` | Run the worktree-local dev stack with HMR (daemon + vite). Foreground. The everyday command. |
| `make serve` | Build + run the worktree-local daemon detached. Used by the cockpit's Redeploy chip. |
| `make install` | (Re)install the systemd user service `citadel.service` so it supervises *this* checkout long-term. Idempotent. |
| `make setup` | `pnpm install`. |
| `make stop` | Stop the detached `serve` daemon. (For `deploy`, just Ctrl-C.) |
| `make logs` | Tail the detached daemon's log. |

The systemd-supervised `citadel.service` is the long-running cockpit on the
devbox. `make install` is the only command that touches it; `deploy` and
`serve` are isolated and never restart the service. Each worktree's daemon
binds to a port derived from its absolute path (`4110 + cksum % 100`); on
collision the daemon walks the next free port and writes the chosen port to
`.citadel/dev.json`, which the Makefile and the cockpit Redeploy hook both
read.

## When something looks wrong

- "The cockpit shows a 404 for a route I just added" → you're probably viewing
  the wrong cockpit. Each `make deploy` advertises its URL on startup; the
  systemd service runs at `http://localhost:4010`. Routes added in this branch
  only exist where this branch's daemon is running.
- "Port already in use" → another worktree (or stale process) holds the
  derived port. `make stop` if you started it via `serve`; if it's `deploy`,
  find the foreground terminal and Ctrl-C it.

See `docs/operations/worktree-development.md` for details.

## Conventions for agents

- Do not invoke `pkill -f node` or anything else that could take down the
  user's long-running systemd daemon.
- Do not edit files under `/home/jonsnow/Workspace/citadel/` (the main
  checkout the systemd unit points at) from this worktree.
- When asked to "redeploy" / "restart", prefer `make stop && make serve` or
  just `make serve` (it stops the previous detached daemon first). For HMR
  iteration, ask the user to run `make deploy` themselves in a terminal — it
  is a foreground process.
