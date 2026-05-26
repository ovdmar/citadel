# Install, upgrade, and verify

This is the operator-facing path: install Citadel on your devbox, pin to a tagged version, upgrade between versions, and verify everything is configured.

Two relevant commands: `make install` (or `make upgrade`) and `make doctor`. Everything else is content.

## Pre-requisites

Required on the host:

- Node.js ≥ 24
- pnpm ≥ 10 (Corepack-enabled)
- tmux
- ttyd (set `TTYD_BIN` if it isn't on PATH)
- jq
- bash
- git
- sqlite3
- systemd `--user` (only for the long-term install — not needed for `make deploy` worktree iteration)

Recommended (warn-only — Citadel still works without them):

- `gh` — enables the GitHub provider (PRs, CI runs, checks).
- `jtk` — enables the Jira provider.

`make doctor` validates all of the above.

## First-time install (HEAD of current branch)

```bash
git clone git@github.com:ovdmar/citadel.git
cd citadel
make setup
make install
```

`make install` writes a systemd `--user` unit (`citadel.service`) plus a separate tmux server unit (`citadel-tmux.service`), enables them, builds `apps/daemon`, and brings them up. It is idempotent — re-running on the same checkout safely refreshes the unit and restarts the daemon.

Verify:

```bash
make doctor
```

Expected: top-line `ok` or `degraded` (degraded is fine if `gh` / `jtk` aren't installed — those are warns, not fails).

## Pin to a tagged version

Citadel uses annotated git tags shaped `v<major>.<minor>.<patch>` (e.g. `v0.3.0`). Lightweight tags, branches, and SHAs are not valid pin targets — `make upgrade` and the `CITADEL_INSTALL_REF` env var both refuse them.

```bash
CITADEL_INSTALL_REF=v0.3.0 make install
```

The script `git fetch --tags`, validates the REF, refuses if your working tree is dirty, then checks out the tag, runs `pnpm install --frozen-lockfile`, rebuilds, and restarts the service.

## Upgrade

```bash
# Upgrade to the latest commit on the current branch (no REF)
make upgrade

# Upgrade to a specific annotated tag
make upgrade REF=v0.3.1
```

`make upgrade` is a thin verb on top of `scripts/upgrade.sh`. It validates the REF (when given), refuses to run from a worktree whose path differs from the installed `citadel.service`'s `WorkingDirectory=`, refuses dirty trees when pinning, then delegates to `scripts/install-systemd.sh`.

After upgrade, the daemon restart is asynchronous — `systemctl restart` returns before the daemon is listening. **Use `make doctor` to verify**, not `curl /api/health` (doctor retries 5×1s; raw curl can race the restart). Document this so operators don't read transient failures as breakage.

Tmux sessions survive a daemon restart — Citadel uses a *separate* `citadel-tmux.service` for the tmux server precisely so agents don't churn. ttyd processes are recreated; the cockpit reattaches automatically.

### Failed-release recovery

Tagging a release triggers `.github/workflows/release.yml`, which runs `make check` *before* `gh release create`. If `make check` fails, the GitHub Release is **not** published. To recover: delete the tag locally and on origin, fix the issue on `main`, and re-cut:

```bash
git push --delete origin v0.3.0
git tag --delete v0.3.0
# fix, commit, push
git tag v0.3.0
git push --tags
```

## Verify: `make doctor`

```bash
make doctor             # human-readable table
make doctor --json      # machine-readable DoctorReport JSON
```

The doctor checks:

- **Required binaries** (node, pnpm, tmux, ttyd, bash, git, sqlite3, jq) — missing → `fail`.
- **Recommended binaries** (gh, jtk) — missing → `warn`.
- **Config** — exists, parses, zod-validates. TLS cert (if configured) loads, is non-empty, and is not expired. Warns when < 7 days from expiry.
- **Systemd services** — `citadel.service` and `citadel-tmux.service` active. `skipped` if systemd is not the install path (e.g. dev worktree).
- **Daemon reachability** — `GET <bindHost>:<port>/api/health` with 5×1s retry. Reports `protocol: http | https` and the bind URL.
- **Database schema** — `MAX(version)` in `schema_migrations` matches the expected constant.
- **Per-repo hooks** — each registered repo: any hooks bound? `.citadel/hooks/deploy` present and executable? No → `warn` with a hint pointing at the cockpit's "Scaffold with AI" affordance.
- **Providers** — for each enabled provider:
  - Unconfigured (binary missing / disabled / no auth) → `warn` with hint "provider unconfigured — features X disabled".
  - Configured but unreachable → `fail`.
  - Healthy → `ok`.
- **bind-host-tls** — warn when `bindHost` is non-loopback AND `config.tls` is absent. No warn for loopback + TLS (the normal mkcert pattern).

The top-line summary follows: any `fail` → `failing`; else any `warn` → `degraded`; else `ok`. `skipped` doesn't contribute.

Dev-mode degraded vs. broken: on a fresh devbox without `gh` / `jtk` you'll see `degraded` because of the warn-only recommended-binary checks. That's expected. `failing` indicates a real problem.

## HTTPS (optional)

The daemon binds plain HTTP on `127.0.0.1` by default. HTTPS is opt-in for operators binding a non-loopback host (LAN exposure, Tailscale) or testing TLS locally.

1. Generate a cert. The easiest path is [mkcert](https://github.com/FiloSottile/mkcert):

   ```bash
   mkcert -install
   mkcert -key-file ~/.local/share/citadel/key.pem -cert-file ~/.local/share/citadel/cert.pem localhost 127.0.0.1
   ```

2. Edit `~/.local/share/citadel/citadel.config.json`:

   ```jsonc
   {
     "bindHost": "127.0.0.1",  // or your LAN IP
     "port": 4010,
     "tls": {
       "certPath": "/home/<you>/.local/share/citadel/cert.pem",
       "keyPath":  "/home/<you>/.local/share/citadel/key.pem"
     },
     // ... rest of the config
   }
   ```

3. Restart: `systemctl --user restart citadel.service`.

4. Verify: `make doctor` — expect `protocol: https`. The cockpit URL is now `https://<host>:<port>`.

**Cert expiry.** The daemon refuses to boot with an expired cert. The doctor warns when < 7 days from expiry. Regenerate via mkcert and restart.

**LAN exposure.** Binding a non-loopback host without TLS triggers a warning in both the boot log and the doctor (`bind-host-tls`). HTTPS + a firewall rule (or Tailscale) is the supported pattern for multi-machine cockpit access.

## Troubleshooting

For dev / worktree iteration, see [worktree-development.md](./worktree-development.md). The `make install` path is the long-term install; worktree dev uses `make deploy` and lives in `.citadel/data/` per-checkout.

| Symptom | Likely cause |
|---|---|
| `make doctor` reports `daemon unreachable` immediately after `make upgrade` | Race with async systemctl restart; rerun `make doctor` (it retries) |
| `make upgrade REF=...` refuses with "ref must match v<x>.<y>.<z>" | REF is not an annotated semver tag |
| `make upgrade` refuses with "working directory mismatch" | You're not in the checkout the systemd unit points at |
| Cockpit URL won't load over HTTPS | Cert not in your system trust store; re-run `mkcert -install` |
| Cockpit returns 404 for routes you just added | You're hitting `:4010` (systemd long-term) instead of your worktree's `:5210-5309` (vite HMR) |
