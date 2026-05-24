# Worktree development

Citadel is local-first: every command is scoped to the checkout you run it
from. There are exactly two commands you need.

## The model

| Command | Audience | What it does |
|---|---|---|
| `make install` | A user (or your devbox) installing Citadel for long-term use | Writes/refreshes the systemd `--user` unit `citadel.service` so it supervises *this* checkout. Idempotent. Run it once per machine, and again whenever you `git pull` on the long-term checkout or swap it. |
| `make deploy` | A dev working on Citadel itself | Starts the worktree-scoped HMR dev stack (daemon under `tsx watch` + vite under HMR, detached in one process group). The cockpit's "Redeploy" chip invokes the same command. |

There is no third command for "deploy without HMR" or "deploy from main vs.
deploy from a worktree". `make deploy` always does the right thing for the
current checkout.

`make deploy` is independent of `make install` — you can run it in any fresh
clone without ever installing the systemd service.

## What `make deploy` does

1. Stops any prior dev stack started here (kills the recorded process group).
2. Frees the derived daemon and vite ports if anything is squatting them.
3. Writes `.citadel/dev.json` so the deploy hook + cockpit know which web port
   to advertise.
4. Launches `pnpm dev` via `setsid nohup`, scoped to:
   - `CITADEL_PORT` — derived daemon port (`4110 + cksum(absolute_path) % 100`)
   - `CITADEL_WEB_PORT` — derived vite port (`5210 + cksum(absolute_path/web) % 100`)
   - `CITADEL_DATA_DIR` — `<checkout>/.citadel/data/` (own SQLite, own config)
   - `CITADEL_DAEMON_URL` — pointing vite's proxy at the worktree daemon
5. Polls `/api/state` until the daemon answers (≤20s), then prints the URLs
   and returns. The user clicks the cockpit URL; subsequent source edits
   hot-reload — no need to re-run `make deploy`.

## Ports and storage

| Resource | Location |
|---|---|
| Daemon port | `4110 + cksum(absolute_path) mod 100` (range 4110–4209) |
| Cockpit / vite port | `5210 + cksum(absolute_path/web) mod 100` (range 5210–5309) |
| Effective port (after EADDRINUSE fallback) | `.citadel/dev.json:.port` / `.webPort` |
| SQLite + config | `<checkout>/.citadel/data/` |
| Combined daemon+vite log | `<checkout>/.citadel/logs/daemon.log` |
| PGID of the dev stack | `<checkout>/.citadel/logs/daemon.pid` |

If two worktrees hash to the same daemon port, the second one's daemon walks
the next free port on `EADDRINUSE` and persists it to `.citadel/dev.json`.
The Makefile and the deploy hook both read `dev.json` first, so URLs always
match where the stack is actually listening.

## Typical flows

**Fresh clone or new worktree — get me running:**

```
make setup     # pnpm install (once per checkout)
make deploy    # detached HMR stack; prints the cockpit URL
# visit the URL it prints; edit source freely (HMR)
make logs      # if you want live output
make stop      # when done
```

**I want this checkout to be the long-term daemon on this devbox:**

```
make install   # writes/refreshes ~/.config/systemd/user/citadel.service → this checkout
```

After `git pull`, `make install` (or `systemctl --user restart
citadel.service` if you only need a restart and the unit is already current).

**The cockpit's "Redeploy" chip:**

It calls `.citadel/hooks/deploy redeploy` in the target workspace path, which
runs `make -s deploy`. Same command, same isolation, same HMR. The chip is
just a convenience trigger for `make deploy` in another worktree.

## Troubleshooting

**"My new backend route returns 404 in the cockpit."**

Check the URL bar:
- `:4010` → systemd long-term daemon (whatever checkout `make install` last
  pointed it at). Probably not your branch.
- `5210–5309` → vite HMR cockpit for some worktree. The vite proxy forwards
  `/api` to the worktree daemon at `CITADEL_DAEMON_URL`. Your branch's routes
  exist here iff `make deploy` was run from your worktree.
- `4110–4209` → a raw worktree daemon (no HMR, no vite). Rare — only if
  someone is running `node apps/daemon/dist/index.js` directly.

**"Port already in use."**

Either another worktree's dev stack holds the derived port, or a previous
`make deploy` didn't clean up. `make stop` clears the stack recorded for this
worktree; `fuser -n tcp <port>` shows who else has it.

**"`make deploy` started but the cockpit doesn't load."**

`make logs` tails the combined daemon + vite output. tsx watch keeps running
on compile errors — look there first.

## Why this is the shape

The original failure mode: a developer opens a worktree, runs `pnpm dev`, and
vite's default proxy (`http://127.0.0.1:4010`) silently routes API calls to
the systemd long-term daemon — which is running a *different branch*. New
backend routes 404 even though the worktree's source has them. Pinning every
port to the worktree's identity and proxying through that — done
automatically by `make deploy` — removes the misrouting class entirely. Same
command from a terminal or from the cockpit's Redeploy chip means the
experience is identical no matter who triggers it.
