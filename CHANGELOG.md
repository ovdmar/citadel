# Changelog

All notable changes to Citadel are listed here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the repo is pre-public so versions track the install/upgrade surface rather than API stability.

## 0.3.0 — Onboarding, setup, distribution

### Added
- **Distribution surface.** Releases are annotated git tags shaped `v<major>.<minor>.<patch>`. A new `.github/workflows/release.yml` triggers on `v*` tags, runs `make check`, and only then publishes a GitHub Release.
- **`make upgrade` verb.** Dedicated upgrade command. Fast-forwards the current branch by default; `make upgrade REF=v0.3.0` validates the REF (annotated tag, dirty-tree refusal, working-directory equality with the systemd unit) before delegating to `scripts/install-systemd.sh`.
- **Pinned installs.** `CITADEL_INSTALL_REF=v0.3.0 make install` checks out the requested annotated tag first. Refuses lightweight tags, branches, SHAs, and dirty trees.
- **Shared install guards.** `scripts/install/install-guards.sh` is sourced by both `install-systemd.sh` and `upgrade.sh` so refusal contracts cannot diverge.
- **`make doctor`.** A programmatic "is everything configured?" check. Probes required binaries, recommended binaries, config validity, systemd services, daemon reachability (5×1s retry), database schema version, per-repo hooks, providers, and the inverse TLS warning. Reachable from the shell (`make doctor`) and the cockpit (Settings → Diagnostics). JSON contract via `GET /api/doctor`.
- **HTTPS support (opt-in).** Optional `config.tls = { certPath, keyPath }` switches the daemon to `https.createServer`. Cert and key are validated at boot (existence, non-empty, expiry). Boot log + doctor warn when `bindHost` is non-loopback AND `tls` is absent (never the inverse — mkcert + 127.0.0.1 is a normal pattern).
- **AI-assisted hook scaffolding.** Settings → Repositories → `<repo>` shows a "Scaffold with AI" button when no hooks are bound. Clicking spawns a fresh worktree on `hook-scaffold-<ts>` and starts a Claude Code session primed with Citadel's own `.citadel/hooks/deploy` as the canonical template. Second click on the same repo reuses the in-flight scaffold session.
- **Operator docs.** `docs/operations/install.md` (install, pin, upgrade, verify, HTTPS, failed-release recovery) and `docs/operations/hook-examples.md` (canonical deploy hook + stubs for setup/apps/action).

### Changed
- README quickstart now shows `make deploy` (current dev pattern), not the long-removed `make dev`. New `## Install (long-term)` section.
- Spec `B.6` gets a new `## Verification` section codifying the doctor's check kinds and warn-vs-fail contracts.
- Spec `C` gets `## Distribution` and `## HTTP And HTTPS` sections.
- `apps/daemon/src/mcp-routes.ts` server-info advertises `0.3.0`.

### Known gaps
- B.6 AC 1 — first-run config/init wizard remains unticked. The doctor + AI empty-state delivers the verification + remediation half; a guided first-run flow is deferred to a future release.
- B.6 AC 5 — doctor *diagnoses* repo configuration; it does not yet *gate* workspace flows on a failing doctor report. Gating is a deferred follow-up.
- Signed-tag verification for `make upgrade REF=` (currently validates annotated-tag shape only).
- Automatic rollback on a failed-health upgrade (operator-driven recovery for now: roll back to the previous tag via `make upgrade REF=v<prev>`).
- Telemetry on scaffold-hook success rate — Citadel is local-first and has no telemetry surface today.

## 0.2.0 and earlier

See `docs/campaigns/citadel-v2-implementation-log.md` for the pre-tagging-cadence history.
