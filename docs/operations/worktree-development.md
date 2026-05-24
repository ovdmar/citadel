# Worktree development

Citadel is local-first: every command you run from a checkout is scoped to
that checkout. There is no implicit dispatch to "main" and no shared mutable
state between worktrees. This document explains how the model works so you
don't end up testing a worktree's UI against a different branch's daemon
(which used to happen on every fresh worktree).

## Mental model

There are three independent things that can be running:

1. **The long-term systemd-supervised daemon** — `citadel.service` (`--user`).
   Configured once per machine via `make install` from whichever checkout you
   want to be "the long-term one". Listens on the daemon's configured port
   (default `4010`). Restart with `systemctl --user restart citadel.service`.

2. **A worktree HMR dev stack** — what you get from `make deploy`. Vite serves
   the cockpit with hot-reload on a worktree-derived port and proxies API
   calls to a worktree-local daemon on another worktree-derived port. Both run
   in the foreground (Ctrl-C stops them). The everyday development command.

3. **A worktree detached daemon** — what you get from `make serve` (or from
   the cockpit's "Redeploy" chip on a workspace card). Builds the cockpit,
   starts the daemon detached, daemon serves the built cockpit from its own
   origin — no proxy, same origin, fully self-contained. Stop with
   `make stop`.

The systemd daemon and any number of worktree daemons can coexist; they bind
different ports and use different SQLite stores.

## Ports and storage

For every worktree (or main checkout):

| Resource | Location |
|---|---|
| Daemon port | `4110 + (cksum(absolute_path) mod 100)` (range 4110–4209) |
| Cockpit/HMR port | `5210 + (cksum(absolute_path + "/web") mod 100)` (range 5210–5309) |
| Effective port (after EADDRINUSE fallback) | `.citadel/dev.json:.port` |
| SQLite + config | `<checkout>/.citadel/data/` |
| PID + log of detached daemon | `<checkout>/.citadel/logs/` |

If two worktrees hash to the same daemon port, the second one's daemon walks
the next free port on `EADDRINUSE` and persists the chosen port to
`.citadel/dev.json`. The Makefile and the deploy hook both read `dev.json`
first, so the URLs they print/advertise always match where the daemon is
actually listening.

## Typical flows

**I just cloned (or created a new worktree). Get me running.**

```
make setup     # pnpm install
make deploy    # foreground HMR; prints the cockpit URL
# visit the URL it prints
# Ctrl-C when done
```

**I want this checkout to be the long-term daemon on this devbox.**

```
make install   # writes ~/.config/systemd/user/citadel.service → this checkout, enables it
```

After a `git pull` on that checkout, re-run `make install` (or `pnpm build &&
systemctl --user restart citadel.service`) to bring the new code up.

**I want the cockpit's "Redeploy" chip to bring up another worktree without
me opening a terminal there.**

It already does this. The chip invokes `.citadel/hooks/deploy redeploy`,
which `cd`s into the target worktree and runs `make serve` (build + detached
daemon). The advertised URL — printed in the workspace card and in the deploy
activity log — comes from `.citadel/dev.json`.

## Troubleshooting

**"My new backend route returns 404 in the cockpit."**

You're talking to the wrong daemon. Check the URL bar:
- `http://…:4010` → systemd long-term daemon (whatever checkout `make install`
  last pointed it at). Probably not your branch.
- `http://…:5210–5309` → vite HMR cockpit. The vite proxy forwards `/api` to
  `CITADEL_DAEMON_URL` — that's the worktree daemon `make deploy` started in
  the same terminal. If you visit this URL without running `make deploy`, the
  proxy will fail.
- `http://…:4110–4209` → a detached worktree daemon serving its own built
  cockpit. Routes match whatever branch was built when `make serve` ran.

**"Port already in use."**

Either another worktree (or stale `serve` daemon) holds the derived port.
`make stop` clears the detached daemon recorded for this worktree;
`fuser -n tcp <port>` shows who else has it. The HMR `make deploy` path is
foreground, so just Ctrl-C the terminal running it.

**"I can't tell which daemon is which in `ss` / `netstat`."**

- `:4010` → systemd `citadel.service`
- `4110–4209` → worktree-derived daemon ports (cksum-mod-100)
- `5210–5309` → worktree-derived vite HMR ports

The Makefile's `make help` from inside a worktree always prints the resolved
ports for that worktree.

## Why this is the shape

The original failure mode: a developer opens a worktree, runs `pnpm dev`, and
the vite proxy default (`http://127.0.0.1:4010`) silently routes API calls to
the systemd long-term daemon — which is running a *different branch*. New
backend routes 404 even though the worktree's source has them. Hard to
diagnose because the cockpit and the daemon disagree about reality without
saying so. Pinning everything to a worktree-derived port and proxying through
that — set automatically by `make deploy` — removes the misrouting class
entirely.
