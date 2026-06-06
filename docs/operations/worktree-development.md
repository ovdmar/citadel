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
   - `CITADEL_AUTOMATED_GH=0` — automated GitHub polling is off for worktree
     deploys by default, so multiple agent worktrees do not drain the shared
     `gh` quota. Opt in for one worktree with
     `CITADEL_ENABLE_WORKTREE_GH_AUTOMATION=1 make deploy`.
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
| tmux socket | `citadel-w-<cksum(absolute_path)>` (per worktree, disjoint from prod's `citadel`) |
| Combined daemon+vite log | `<checkout>/.citadel/logs/daemon.log` |
| PGID of the dev stack | `<checkout>/.citadel/logs/daemon.pid` |

If two worktrees hash to the same daemon port, the second one's daemon walks
the next free port on `EADDRINUSE` and persists it to `.citadel/dev.json`.
The Makefile and the deploy hook both read `dev.json` first, so URLs always
match where the stack is actually listening.

## Worktree isolation: how it works

A worktree dev stack must never accidentally talk to the systemd long-term
daemon at `:4010`, **and must never share runtime state (DB, tmux sessions,
ttyds) with the prod daemon**. Six hard isolation points enforce that
contract — if any of them regress, the cockpit silently routes to the wrong
daemon, new backend routes 404, *or* the worktree's orphan-reaper SIGKILLs
prod's live agent panes (2026-05-27 incident). Audit-friendly file:line
citations:

- **Makefile env scrub** — `Makefile:145-157`. Before launching `pnpm dev`,
  `env -u`s every inherited `CITADEL_*` variable and then re-sets
  `CITADEL_WORKTREE=1`, `CITADEL_PORT`, `CITADEL_WEB_PORT`, `CITADEL_DATA_DIR`,
  `CITADEL_DAEMON_URL`, `CITADEL_AUTOMATED_GH=0`, and `CITADEL_TMUX_SOCKET`
  to worktree-pinned values. This is the primary isolation seam.
- **Per-worktree tmux socket** — `Makefile` sets `CITADEL_TMUX_SOCKET=citadel-w-<cksum>`;
  `apps/daemon/src/index.ts` branches on `isWorktreeDaemon` and calls
  `ensureWorktreeTmuxRunning(socket)` (`packages/terminal/src/index.ts`)
  instead of the systemd-aware `ensureCitadelTmuxRunning()`. The worktree
  tmux server is spawned detached so it survives HMR restarts; its socket
  is disjoint from the systemd-managed `citadel` socket, so `reapOrphans`
  on the worktree daemon can never see prod sessions.
- **Daemon env validation** — `apps/daemon/src/index.ts:26-43`. When
  `CITADEL_WORKTREE=1`, the daemon rejects any inherited `CITADEL_CONFIG` or
  `CITADEL_DATA_DIR` that points outside the worktree, and forces the data dir
  to `${worktreeRoot}/.citadel/data`. Defense in depth against a leaked env.
- **Daemon refusal to bind `:4010`** — `apps/daemon/src/index.ts:47-52`. A
  worktree daemon with no `CITADEL_PORT` exits non-zero rather than clobber
  the systemd-reserved port.
- **ttyd slot disjointness** — `apps/daemon/src/ttyd-slot.ts`. Each daemon
  computes a per-instance ttyd port slot from `(((daemonPort - 4010) % 11) + 11) % 11`
  (200 ports wide). The systemd daemon and worktree daemons land in disjoint
  slots so ttyd ports never collide. NB: ~9% of worktree ports (every 11th
  in the 4110–4209 range) hash into slot 0 — same as prod. With the
  per-worktree tmux socket now in place, this is no longer catastrophic
  (the adopted ttyds would point at sessions on a *different* tmux server),
  but it still leaks process names — track as a follow-up.
- **Vite proxy reads `CITADEL_DAEMON_URL`** — `apps/web/vite.config.ts:21-32`.
  Every proxy target (`/api`, `/events`, `/terminals`, `/terminal`) reads the
  env var. `make deploy` sets it explicitly, so the cockpit always reaches its
  own daemon.

### Where `:4010` legitimately appears

Production-code references to `:4010` are intentional and must not be
"cleaned up" — removing them breaks the systemd path. The audit's full
classification:

| File:line | Code | Verdict |
|---|---|---|
| `apps/web/vite.config.ts:21,22,25,31` | `process.env.CITADEL_DAEMON_URL \|\| "http://127.0.0.1:4010"` | Intentional. Bare `pnpm dev` (no `make deploy`) is a supported UI-only workflow that targets the systemd daemon. `make deploy` always sets the env var. Keep. |
| `apps/daemon/src/ttyd-slot.ts` | ttyd slot math + comment | Intentional. Modular origin for disjoint port slots. Keep. |
| `apps/daemon/src/app.ts:115` | Comment about cleanupStale skip for `config.port=4010` | Intentional. Documents the production-install slot collision rationale. Keep. |
| `apps/daemon/src/index.ts:8,49` | Comment + error message | Intentional. Refuses to bind `:4010` from a worktree daemon. Keep. |
| `packages/config/src/index.ts:76` | `port: …default(4010)` | Intentional. Schema default for the systemd unit. Keep. |
| `scripts/dev/smoke.ts:1`, `scripts/dev/performance-smoke.ts:8` | `process.env.CITADEL_BASE_URL \|\| "http://127.0.0.1:4010"` | Intentional. Smoke scripts target the systemd daemon by default; overridable via env var. Keep. |
| `scripts/install-systemd.sh:45,48` | `Environment=CITADEL_PORT=4010` | Intentional. Systemd unit. Keep. |
| `packages/config/src/index.test.ts:219,227,262,269` | Test fixtures | Intentional. Test data. Keep. |

Doc/README references to `:4010` describe the systemd port for operators —
they are not leaks. Don't grep-and-replace them.

## Seeding worktree data (so the cockpit isn't empty)

A fresh worktree starts with an empty SQLite — no workspaces, no namespaces,
no scratchpad. That's useless for QA: you can't see whether your branch
changed something in the cockpit if the cockpit has nothing to render.

The seed is a checked-in, fully synthetic fixture (under `seeds/` in this
repo): a tiny mock git repo and a small set of `INSERT`s. It is intentionally
**not** sourced from the systemd long-term daemon's data — that would copy
live `agent_sessions` rows that reference real tmux sessions, and the
worktree daemon booted on top would race the live daemon for ownership of
those sessions, breaking the live cockpit.

| Command | What it does |
|---|---|
| `make seed` | Materializes `<checkout>/.citadel/mock-repo/` (a git repo with two `feature/*` worktrees under `mock-worktrees/`) and inserts fixture rows into `<checkout>/.citadel/data/citadel.sqlite`: 1 namespace, 1 repo, 2 workspaces (one with a PR snapshot + Jira issue), 10 activity events, and a 3-block scratchpad. Idempotent. Touches **only** safe-to-seed tables — never `agent_sessions`, `background_sessions`, `operations`, or `scheduled_agents`. |
| `make seed-reset` | Stops this worktree's dev stack, removes the SQLite + mock repo + mock worktrees, and re-seeds from scratch. Use for a clean QA baseline. |

`make deploy` auto-runs `make seed` if neither the mock repo nor the SQLite
exist (i.e., on the very first deploy of a fresh worktree). After that, it
leaves the worktree's data alone — use `seed-reset` to refresh.

Typical flow:

```
cd /path/to/some-worktree
make setup                       # pnpm install (once per checkout)
make deploy                      # auto-seeds; cockpit has data
# …work in the worktree, mutate state freely…
make seed-reset && make deploy   # back to a clean QA baseline
```

**What's NOT seeded, and why:**

- No `agent_sessions` / `background_sessions` rows — those carry tmux
  session names that the daemon will try to attach to at boot, and any
  collision with the systemd long-term daemon's sessions would steal them
  away from the live cockpit.
- No `operations` rows — they reference in-flight async work that doesn't
  exist after a daemon restart.
- No scheduled agents — they'd start firing crons against the mock repo.

If you need to QA agent-launch / scheduled-agent / background-session flows,
trigger them through the seeded cockpit yourself (start an agent on
`demo-feature`, etc.). That way the rows reference *this* worktree's tmux
and daemon.

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
