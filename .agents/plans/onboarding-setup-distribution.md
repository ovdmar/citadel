Activate the /implement-task skill first.

# Plan: Onboarding, setup, distribution

## Acceptance Criteria

Verbatim from the topic in the scratchpad:

- [ ] Define distribution (fixed releases) — a documented model that lets an operator pin a specific Citadel version, plus the GitHub-side surface (tagged release + asset) that backs it.
- [ ] Install flow — a single documented path that takes an operator from a fresh checkout to a running, supervised Citadel without having to read source.
- [ ] "Is everything configured?" verification — a programmatic, repeatable answer to that question. Reachable from the cockpit and from the shell.
- [ ] Hook examples — operator-facing reference material for the supported hook events (`workspace.setup`, `workspace.teardown`, `workspace.apps`, `workspace.action`, `workspace.created`, `workspace.archived`, `workspace.removed`, `agent.started`) plus the per-worktree deploy hook.
- [ ] HTTP vs HTTPS support — operators who want HTTPS can opt into it without forking; HTTP remains the default.
- [ ] `make upgrade` — a dedicated verb that updates the long-term install to a new version of Citadel. Even though it largely shares behavior with `make install`, the verb is part of the published surface.
- [ ] AI in empty states — when a registered repo has no hooks, the cockpit offers to scaffold the canonical hook by launching an interactive agent (via the existing `launch_agent` MCP primitive) primed with Citadel's own `.citadel/hooks/deploy` as the example. The operator is not pointed at a manual file path.

## Context and problem statement

Citadel ships as a local-first cockpit installed from a git checkout. Today there is:

- A `make install` target that writes a systemd `--user` unit pointing at the current checkout (`scripts/install-systemd.sh`). It is idempotent but does not support pinning a ref — operators install from whatever HEAD happens to be checked out.
- No tagged releases, no CHANGELOG, no `package.json` version-bump cadence. CI (`.github/workflows/ci.yml`) only runs on PR/push to main; it never publishes.
- No `make upgrade`. The honest path today is "`git pull && make install`".
- A provider-health-focused `/api/health` endpoint (`apps/daemon/src/app.ts:136`). No system-wide "is everything wired up" check. No `doctor` command — `apps/cli/src/index.ts` is a single placeholder export.
- An HTTP-only daemon — `apps/daemon/src/app.ts:89` hardcodes `http.createServer(app)`. The config schema (`packages/config/src/index.ts`) has `bindHost`/`port` but no TLS knobs. The README explicitly recommends 127.0.0.1; there is no documented path for operators who want HTTPS (LAN exposure with self-signed certs, devbox accessed over Tailscale, etc.).
- A repo settings UI (`apps/web/src/routes/repo-settings.tsx:105`, `RepoHooksSection`) that renders an empty `"No hooks bound to this repo"` chip when nothing is configured, with no remediation path.
- A canonical, working example in this very repo: `.citadel/hooks/deploy` (Citadel deploying itself). It is the perfect AI fixture but is currently un-leveraged.
- A `launch_agent` MCP tool (`packages/mcp/src/index.ts:343`, `packages/operations/src/launch-agent.ts:52`) that already does the one-shot "create workspace + start a primed Claude Code session" — the empty-state AI button can be built almost entirely from primitives that exist.

The change is to fold these gaps into one onboarding/setup/distribution release: define how operators pick a version, install/upgrade, verify their install, and bootstrap their first repo's hook without writing it from scratch.

## Spec alignment

| Spec | Touched? | What changes |
|---|---|---|
| `specs/B.6-providers-hooks-config.md` | Yes | First-run config + verification surface, hook scaffolding, settings-side "configured?" overview. Update **Config And Settings** ACs and add a "**Verification**" subsection. |
| `specs/B.5-apps-links-actions.md` | No | Behavior unchanged; only the empty-state path leading to a hook gets a new affordance. No new app/link/action contracts. |
| `specs/C-technical-stack.md` | Yes | Distribution model (tagged releases), `make upgrade`, optional HTTPS, documented install pre-reqs. Add "**Distribution**" and "**HTTP/HTTPS**" subsections. |
| `specs/A-shared-definitions.md` | No | No new domain terms — Hook, Workspace, Agent session, Operation are already defined. |
| `docs/operations/runbook.md`, `docs/architecture/citadel-v2-architecture.md` | Yes | Doc updates only. Runbook gets pointers; architecture gets a one-line note on the optional TLS path. |

**Discrepancies found.**
- `B.6 → Config And Settings` AC 1 ("first-run config/init surface") remains unticked — a wizard is out of scope.
- `B.6 → Config And Settings` AC 5 ("Settings can validate a repository configuration before it is used by workspace flows") — doctor delivers **diagnosis only**, not gating. AC explicitly remains open with a follow-up entry in `CHANGELOG.md` "Known gaps". Plan does **not** mark this AC as `[~]` because the AC's plain-language reading is "validate before use" (i.e., gate the flow), which we are not delivering in this PR.

The first implementation step is the spec update — see Implementation steps.

## Implementation approach

Five focused units, executed in order, each independently shippable in TDD order:

1. **Spec + docs updates first.** `B.6` and `C` get the new ACs and a Distribution / HTTP-vs-HTTPS subsection. New `docs/operations/install.md` and `docs/operations/hook-examples.md`. README quickstart points at install.md. This sets the contract before any code changes.
2. **Distribution & `make upgrade`.** Bump `package.json` version to `0.3.0` (with an explicit `rg`-grep audit step). Add `CHANGELOG.md`. Add `.github/workflows/release.yml` triggered on `v*` tags — runs `make check` *first*, then `gh release create` only on success. Extend `scripts/install-systemd.sh` to honor an optional `CITADEL_INSTALL_REF`. Add a `make upgrade` Makefile target wrapping a new `scripts/upgrade.sh` that validates REF shape, refuses to run from a worktree that isn't the systemd-pointed checkout, and refuses dirty trees when pinning a ref.
3. **Doctor / "is everything configured?".** Three-layer split to satisfy the architecture-boundary gate:
   - `packages/contracts/src/doctor.ts` — zod schemas for `DoctorReport`/`DoctorCheck`. Pure types.
   - `packages/core/src/doctor.ts` — pure functions only: `summarizeDoctor`, status precedence, label helpers. No fs/process/config imports.
   - `packages/operations/src/doctor.ts` — the actual check runner (binary probes, config validation, systemctl/HTTP probes, repo-hook inspection). Operations is allowed to import implementation packages.
   - `apps/daemon/src/doctor-routes.ts` — new route module (mirrors existing `registerTerminalRoutes` pattern) that exposes `GET /api/doctor`.
   - `scripts/doctor/run.ts` — CLI entry that calls into `packages/operations`.
   - `apps/web/src/routes/settings-diagnostics.tsx` — cockpit panel.
4. **HTTP/HTTPS support.** Extend `CitadelConfigSchema` with optional `tls?: { certPath: string; keyPath: string }`. Extract server-factory branching out of `app.ts` into a new `apps/daemon/src/server-factory.ts` (also serves the file-size gate — see Unit 4 for the explicit pre-extraction step). Daemon uses `https.createServer({key, cert}, app)` when `tls` is set; otherwise `http.createServer(app)`. Add `protocol` to `DoctorReport`. Warn (in doctor + at boot) when `bindHost` is non-loopback AND `tls` is absent — not the inverse.
5. **AI-assisted hook scaffolding empty state.** Build-time generation of `assets/hook-templates/citadel-deploy.sh` from `.citadel/hooks/deploy` via a sed-based sanitiser script (avoids drift). Unit test asserts the asset matches the regenerated output byte-for-byte. New `apps/daemon/src/scaffold-hook-routes.ts` (route module) wraps `OperationService.launchAgent` with a primed prompt. Lookup by `hook-scaffold-*` branch prefix to **reuse an in-flight scaffold workspace** instead of spawning duplicates. Cockpit affordances in `RepoHooksSection` and `RepoDeployHookSection`; an "in-flight" banner is rendered on the parent repo settings page until the scaffolded PR merges.

Order rationale:
- Specs first locks contract early.
- Distribution / upgrade is self-contained Makefile + workflow.
- Doctor lands before HTTPS so HTTPS can populate the new `protocol` field.
- Scaffolding is last; it depends on no earlier unit and can ship even if doctor surfaces aren't fully polished.

## Alternatives considered

**A. Make distribution an `npm publish` of a single CLI package.**
*Rejected.* Citadel is a multi-package monorepo that boots a daemon, a web app, supervises ttyd, talks to tmux, and reads SQLite from the install root. The artifact is the checkout. Source-on-disk install matches how the systemd unit references `apps/daemon/dist/index.js` directly.

**B. Build a first-run wizard route in the cockpit instead of a doctor + AI empty-state.**
*Rejected for this round.* A wizard imposes a happy path on operators who often drop into Settings/Advanced. Doctor (machine-readable, repeatable) plus per-repo empty-state remediation gives parity without forcing linear flow. B.6 AC 1 remains a future ticket.

**C. Use a separate sub-agent CLI (sub-process spawned by the daemon) to author the hook instead of `launch_agent`.**
*Rejected.* `launch_agent` already creates a fresh worktree on a new branch and starts Claude Code with a primed prompt. A parallel path would split the operator's mental model.

**D. Ship HTTPS via a Caddy/Traefik sidecar instead of inline.**
*Rejected.* A sidecar requires the operator to install and supervise a second daemon — exactly the friction this plan is removing. Node's `https` module with `{key, cert}` is ~10 lines of branching at bootstrap.

**E. Inline the hook scaffolding prompt into `launch_agent`'s MCP tool itself.**
*Rejected.* `launch_agent` is generic ("run this prompt in repo X"). Folding hook-templating into it would conflate two responsibilities.

**F. Put the doctor library in `packages/core` only.**
*Rejected.* Core's purity gate forbids fs/process/config imports. The check runner needs all three. Three-layer split (contracts/core/operations) is the only way to satisfy both the gate and the parity-between-CLI-and-daemon requirement.

## Implementation steps

### Unit 1 — Spec + docs

- Update `specs/B.6-providers-hooks-config.md`:
  - Add a new `## Verification` section: doctor structure, checks performed (binary / config / service / daemon / database / repo-hooks / provider), JSON shape contract reference, both cockpit and CLI surfaces.
  - Leave `Config And Settings` AC 5 as `[ ]` and add an explicit note: "Diagnosis surface delivered in `make doctor` / `/api/doctor`; **gating** of workspace flows on a failing doctor is a deferred follow-up (tracked in CHANGELOG Known gaps)."
- Update `specs/C-technical-stack.md`:
  - New `## Distribution` section: tagged releases (`v<semver>`), GitHub Release per tag, `make upgrade [REF=v0.3.0]`, install-systemd.sh ref pinning, source-as-artifact rationale, tag-delete recovery procedure.
  - New `## HTTP and HTTPS` section: HTTP default at 127.0.0.1, optional inline TLS via `config.tls`, mkcert recipe pointer, explicit non-goal: not a reverse-proxy replacement. Note that the inverse-warning (warn on non-loopback bind without TLS) lives in doctor + boot log.
- New `docs/operations/install.md`:
  - Pre-reqs: node ≥24, pnpm ≥10, tmux, ttyd, jq, bash, git, sqlite3, optional `gh` and `jtk` for providers.
  - Fresh install: `git clone`, `make setup`, `make install`.
  - Pin a specific version: `CITADEL_INSTALL_REF=v0.3.0 make install`.
  - Upgrade: `make upgrade` or `make upgrade REF=v0.3.1`. Document that the daemon restart is async and recommend `make doctor` (which retries) over manual `curl /api/health`.
  - Verify: `make doctor` — expected output (`ok` / `degraded` / `failing`); recognising "dev degraded" vs "broken".
  - HTTPS: when to use; mkcert recipe; config snippet; mkcert + 127.0.0.1 is fine (local TLS testing); operators binding non-loopback must enable TLS.
  - Failed release recovery: `git push --delete origin v<x.y.z>`, re-cut after fix.
  - Troubleshooting cross-reference to `worktree-development.md`.
- New `docs/operations/hook-examples.md`:
  - Inline-rendered canonical deploy-hook contract + stubs for `workspace.setup`, `workspace.apps`, `workspace.action`. Each stub: JSON-in-stdin shape, expected stdout shape, exit-code semantics.
- Update `README.md`:
  - Replace stale `make dev` line in Quickstart with `make deploy`.
  - Add `## Install (long-term)` pointing to `docs/operations/install.md` with one-line examples for `make install` and `make upgrade`.

### Unit 2 — Distribution & `make upgrade`

- **Version audit step (TDD-style).** Before bumping anything: `rg -F '"0.2.0"' -g '*.{ts,tsx,json,md}'` (literal glob — `tsx` is not a default ripgrep type). Capture the full list. Every match must be updated together. Add the audit output as a one-time block-comment to the PR description so reviewers can confirm none was missed.
- Bump root `package.json` `version` from `0.2.0` → `0.3.0`. Same in `apps/cli`, `apps/daemon`, `apps/web`, every package under `packages/*`. Use `pnpm -r exec` or a single sed pass against the audit list above.
- Add `CHANGELOG.md` with:
  - `## 0.3.0 — Onboarding, setup, distribution` describing the new items here.
  - A `## Known gaps` section listing the deferred items (B.6 AC 1 first-run wizard; B.6 AC 5 doctor-gating; signed tag verification; rollback on failed health).
- New `.github/workflows/release.yml`:
  - Trigger: `push: tags: ['v*']`.
  - Step 1 — `pnpm install --frozen-lockfile` and `make check`. If this fails, the workflow fails and `gh release create` is **never** reached. Document inline that the operator must `git push --delete origin <tag>` to recover.
  - Step 2 (only on success) — `gh release create "$GITHUB_REF_NAME" --generate-notes` (no `--notes-file` — let GitHub generate from PR titles between tags). No artifacts uploaded; source is the artifact.
- New `scripts/upgrade.sh`:
  - Args / env: `CITADEL_INSTALL_REF` env var or `REF=` argument.
  - **REF validation:** require `REF` to match `^v[0-9]+\.[0-9]+\.[0-9]+$` AND `git cat-file -t "$REF"` to return `tag` (annotated tag) — refuse SHAs, branches, and lightweight tags.
  - **WorkingDirectory= equality check:** if `~/.config/systemd/user/citadel.service` exists, parse its `WorkingDirectory=` line. If that path differs from `$(pwd)`, refuse with a clear message listing both paths. This is the explicit guard that Concern F surfaced was missing.
  - **Dirty-tree check:** if `REF` is set and the working tree has uncommitted changes (`git status --porcelain`), refuse with a message naming the dirty paths.
  - If REF given: `git fetch --tags && git checkout "$REF"`. If not: `git pull --ff-only` on the current branch (logged clearly).
  - Then `pnpm install --frozen-lockfile` and exec `scripts/install-systemd.sh`.
- Update `scripts/install-systemd.sh`:
  - Honor `CITADEL_INSTALL_REF` (same `git fetch --tags && git checkout <ref>` step before the existing pre-flight).
  - Add the same WorkingDirectory= equality check as `upgrade.sh` (refactor into a shared `scripts/lib/install-guards.sh` sourced by both).
  - Inline comment markers `# REF-PIN START / # REF-PIN END` around the new block for audit clarity.
- Update `Makefile`:
  - New `make upgrade` target: `bash scripts/upgrade.sh $(if $(REF),REF=$(REF))`. Add to `.PHONY` and help text immediately under `make install`, mirroring tone.

### Unit 3 — Doctor / "is everything configured?"

Three-layer split (explicit, to satisfy the architecture-boundary gate):

- New `packages/contracts/src/doctor.ts`:
  - Zod schemas: `DoctorCheckSchema`, `DoctorReportSchema`.
  - `DoctorReport.version: z.literal(1)` — exact match, no upper-bound coercion.
  - `DoctorCheck` discriminated union by `kind`: `"binary" | "config" | "service" | "daemon" | "database" | "repo-hooks" | "provider"`. Fields: `id`, `kind`, `label`, `status` ("ok" | "warn" | "fail" | "skipped"), `detail?`, `hint?`.
  - Add `protocol: z.enum(["http", "https"])` (populated by Unit 4) and `summary: z.enum(["ok", "degraded", "failing"])`.
  - Exported via `@citadel/contracts` index.
- New `packages/core/src/doctor.ts`:
  - **Pure functions only.** No imports beyond `@citadel/contracts`.
  - Exports `summarizeDoctor(checks: DoctorCheck[]): "ok" | "degraded" | "failing"`. Precedence: any `fail` → `failing`; else any `warn` → `degraded`; else `ok`. `skipped` doesn't contribute.
  - Exports `statusLabel(status)`, `groupChecksByKind(checks)` and similar helpers.
  - Architecture verification: re-run `pnpm check:arch` after this lands.
- New `packages/operations/src/doctor.ts`:
  - The actual check runner. Operations is allowed to import `@citadel/config`, `@citadel/db`, providers, and node builtins.
  - `runDoctorChecks(input: { config: CitadelConfig; store: SqliteStore; mode: "cli" | "daemon" }): Promise<DoctorReport>`.
  - Probes:
    - **Required binaries** (cli mode only — daemon's host already has them): `node`, `pnpm`, `tmux`, `ttyd`, `bash`, `git`, `sqlite3`, `jq`. Use `which`/`command -v` via `node:child_process`. Missing required binary → `status: "fail"`.
    - **Recommended binaries** (cli mode only): `gh`, `jtk`. Missing → `status: "warn"`.
    - **Config**: zod-validate via `@citadel/config`. Parse errors → `fail` with the zod error message.
    - **systemd services** (cli mode only): `systemctl --user is-active citadel.service` and `citadel-tmux.service`. `skipped` when systemd is unavailable (dev worktree). Inactive when expected → `fail`.
    - **Daemon reachability**: `GET <bindHost>:<port>/api/health` with **retry: 5 attempts, 1s apart**. Only the final attempt's failure marks `fail`. Captures the daemon's `databasePath` and `degradedProviders` count on success. Doctor's own daemon route skips this check (it IS the daemon).
    - **Database schema version**: read `MAX(version)` from `schema_migrations`; compare to a constant exported from `@citadel/db`. Mismatch → `fail` with explicit "run pnpm db:migrate" hint (no such command yet — flag as a deferred follow-up in CHANGELOG Known gaps).
    - **Per-repo hooks**: for each registered repo, resolve `.citadel/hooks/deploy` executability and `setupHookIds`/`teardownHookIds` references against the config. Repo with **no hooks bound AND no deploy hook file** → `warn` with hint pointing at `/settings/repos/<id>` (and the "Scaffold with AI" affordance).
    - **Providers**: for each enabled provider (gh, jtk, plus any usage providers), classify per the warn-vs-fail contract:
      - **Unconfigured** (binary missing OR provider explicitly disabled OR auth absent): `status: "warn"`, `hint: "provider unconfigured — features X disabled"`. Top-line summary downgrades to `degraded`.
      - **Configured but unreachable** (binary present but health probe fails): `status: "fail"`. Top-line goes `failing`.
      - **Healthy**: `status: "ok"`.
    - **TLS-on-loopback inversion**: emit one check `id: "bind-host-tls"` that warns when `config.bindHost` is non-loopback (anything other than `127.0.0.1` / `::1` / `localhost`) AND `config.tls` is absent. Does NOT warn for loopback + TLS.
- New `apps/daemon/src/doctor-routes.ts` (separate file — not in `app.ts` — for file-size gate compliance):
  - `registerDoctorRoutes(app, deps)` mirroring the existing `registerTerminalRoutes` pattern.
  - `GET /api/doctor`: runs `runDoctorChecks({ ..., mode: "daemon" })`, returns the report.
- New `apps/web/src/routes/settings-diagnostics.tsx` — cockpit panel under `/settings/diagnostics`.
  - **Version handling**: if `report.version !== 1`, render a banner "Diagnostics report version unknown — upgrade the cockpit". Renders raw JSON beneath for forward-compat consumers.
- New Settings → Overview tile rendering the worst-status badge (`ok`/`degraded`/`failing`) plus a "Run diagnostics" link to the panel.
- New `Makefile` target `make doctor`: `tsx scripts/doctor/run.ts "$@"`. Add to help and `.PHONY`.
  - **tsx dependency confirmation:** `tsx@^4.19.3` is already in root `devDependencies` (root `package.json`). No new dep introduced.
  - **Build prerequisite:** `tsx` resolves the workspace via TypeScript project references at runtime; no pre-build needed. The script imports directly from `packages/operations/src/doctor.ts` source. This matches the pattern used by `scripts/dev/smoke.ts` and `scripts/checks/architecture-boundaries.ts` (already in the repo) — no new invocation pattern.
- `apps/cli/src/index.ts`: add a `doctor` subcommand that shells out to `scripts/doctor/run.ts`. **Optional** — only land if it fits inside the file-size guard for `index.ts` (currently a one-line placeholder). Otherwise defer.

### Unit 4 — HTTP/HTTPS

**Pre-step (file-size gate — explicit):** before adding any new TLS code to `apps/daemon/src/app.ts` (currently 794 lines, 6 lines below the 800-line `scripts/checks/file-size.ts` limit):

1. Extract the `http.createServer(app)` line plus the impending TLS branching into a new `apps/daemon/src/server-factory.ts`. Export `createDaemonServer(app: express.Express, config: CitadelConfig): http.Server | https.Server`.
2. Mount the new `/api/doctor` and `/api/repos/:repoId/scaffold-hook` routes via separate route modules (Units 3 and 5 already specify this — re-confirmed here).
3. Target headroom: `app.ts` ≤ 700 lines after the extraction. Verify with `wc -l apps/daemon/src/app.ts` in the implementation TODO.

Then:

- Extend `CitadelConfigSchema` in `packages/config/src/index.ts`:
  ```ts
  tls: z.object({
    certPath: z.string().refine(absolutePath, "cert path must be absolute"),
    keyPath:  z.string().refine(absolutePath, "key path must be absolute"),
  }).optional()
  ```
  - The zod `.refine()` stays pure (path-shape only): absolute path. Filesystem readability and cert-expiry checks live in a separate post-load validator (`validateTlsAssets(config)`) invoked by the daemon entry — refines stay side-effect-free.
  - **`validateTlsAssets`**: confirms both files exist, are non-zero bytes (catches the "empty mkcert file" misuse), and parses the cert via Node's `crypto.X509Certificate`. Refuses if `validTo` is in the past (boot fails fast with the expiry date). Doctor's `kind: "config"` check runs the same validator and emits `warn` when the cert is within 7 days of expiry.
- `apps/daemon/src/server-factory.ts` implements the branching: `config.tls != null` → `https.createServer({ key, cert }, app)`; else `http.createServer(app)`. WebSocket attachment continues to work — `ws` accepts an `https.Server` identically; verify in tests.
- Boot log line in `apps/daemon/src/index.ts` shows the protocol explicitly (e.g. `→ Daemon listening on https://127.0.0.1:4010`).
- `DoctorReport.protocol` populated from `config.tls != null`.
- **Inverse warning** (from Concern G): doctor + boot-log warn when `config.bindHost` is non-loopback AND `config.tls` is absent. **Do not warn** for loopback + TLS (the normal mkcert dev pattern).
- Documentation in `install.md` covers: mkcert recipe; how to add the cert to the system trust store; warning that the systemd unit's `bindHost` defaults to 127.0.0.1 and operators wanting LAN exposure need both TLS *and* firewall consideration.

### Unit 5 — AI-assisted hook scaffolding empty state

- New `scripts/dev/generate-hook-template.ts`:
  - Reads `.citadel/hooks/deploy`, applies a documented sed-style sanitiser (strips the worktree-specific cksum port derivation, replaces with a `# Replace with your own port/URL derivation` comment block; replaces APP_NAME="citadel" with `APP_NAME="${MY_APP:-app}"`), writes to `assets/hook-templates/citadel-deploy.sh`.
  - Idempotent.
- New `assets/hook-templates/citadel-deploy.sh` (committed; product of the generator).
- New unit test `scripts/dev/generate-hook-template.test.ts` asserts: running the generator against the current `.citadel/hooks/deploy` produces a byte-for-byte match with the committed `assets/hook-templates/citadel-deploy.sh`. Catches drift if either file changes without regeneration.
- New `apps/daemon/src/scaffold-hook-routes.ts` (separate route module — file-size gate compliance):
  - `buildHookScaffoldPrompt(input: { repo: Repo; template: string }): string` — constructs the prompt: you are operating inside a fresh worktree for repo `<name>` at `<path>`; your job is to write `.citadel/hooks/deploy` adapted to this repo's actual app(s); ensure `chmod +x`; run `./.citadel/hooks/deploy list` to validate it returns `{"apps":[...]}` JSON; iterate until validation passes; then stop. Provide the canonical Citadel template inline. Provide the env vars the hook receives (`CITADEL_WORKSPACE_ID`, etc.).
  - **In-flight reuse:** before spawning, list workspaces filtered by `repoId === target && branch.startsWith("hook-scaffold-")` AND `lifecycle === "ready"`. If found, return that workspace + its (possibly running) session id instead of spawning a new one. This satisfies Blocker D's lifecycle policy.
  - `POST /api/repos/:repoId/scaffold-hook` — validates repo exists; finds-or-creates the scaffold workspace; returns `{ workspaceId, sessionId, branchName, workspacePath, operationId, reused: boolean }`.
  - **Lifecycle policy** (documented in install.md + hook-examples.md): scaffold workspaces are normal workspaces. The operator commits + opens a PR via the standard flow. Citadel does NOT auto-delete; the workspace-cleanup-safety gate is respected (dirty trees are never auto-deleted without explicit force).
- Cockpit `apps/web/src/routes/repo-settings.tsx`:
  - In `RepoHooksSection`, when no hooks are bound: render a panel with the message + "Scaffold with AI" button. Button calls `POST /api/repos/:repoId/scaffold-hook`. On `reused: true`, button label says "Resume scaffold session"; on `reused: false`, "Open scaffold workspace".
  - Same affordance in `RepoDeployHookSection` when no `.citadel/hooks/deploy` file is detected AND `deployHookCommand` is empty.
  - **In-flight banner:** when any `hook-scaffold-*` workspace exists for this repo, show a banner at the top of the repo settings page: "Scaffold session in-flight on branch `<name>` — [open workspace]". Banner disappears when the scaffold workspace is archived / its PR merges (no special wiring needed; existing state flow drives the disappearance).
  - On click, after the POST, navigate to the cockpit for the spawned (or reused) workspace.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Config schema (TLS validation, expiry parsing), `packages/core/src/doctor.ts` (summary precedence), `packages/operations/src/doctor.ts` (each probe is mockable), `apps/daemon/src/scaffold-hook-routes.ts` (prompt builder snapshot + in-flight reuse logic), `scripts/upgrade.sh` REF validation + WorkingDirectory check, hook-template generator drift test. Doctor route returns the same shape as the CLI. |
| E2E (Playwright) | **Required for two flows** | (a) Diagnostics tile + panel reflect daemon status (synthetic unhealthy provider → warn). (b) Scaffold-with-AI button POSTs to the right endpoint; new workspace appears in the cockpit; second click reuses the in-flight workspace (banner shows, button label changes). Both use existing isolated-daemon fixtures. |

### New tests to add

- `packages/config/src/index.test.ts` — new `describe("TLS config")`:
  - `accepts a valid tls block when both files exist and cert is non-empty + non-expired` (test generates a self-signed cert via `crypto.generateKeyPair`).
  - `rejects relative cert/key paths`.
  - `rejects missing cert file` (validation error surfaces filename).
  - `rejects empty (0-byte) cert file`.
  - `rejects expired cert` (test generates a cert with `validTo` in the past).
  - `default fixture asserts tls === undefined` (regression — guards against the field becoming required).
- `packages/core/src/doctor.test.ts` — new file:
  - `summarizeDoctor returns "ok" when all checks ok or skipped`.
  - `summarizeDoctor returns "degraded" when any check is warn but none fail`.
  - `summarizeDoctor returns "failing" when any check is fail` (verifies fail > warn precedence).
- `packages/operations/src/doctor.test.ts` — new file:
  - Each probe (binary / config / systemd / daemon / database / repo-hooks / provider) tested in isolation with a fixture daemon + mocked `child_process.execFile`.
  - Provider warn-vs-fail contract: unconfigured provider → `warn` + correct hint; configured-but-unreachable provider → `fail`.
  - Daemon reachability retries 5 times before declaring fail; succeeds on the 3rd attempt is treated as ok.
  - TLS-on-loopback inversion: `bindHost=127.0.0.1` + tls absent → no warn; `bindHost=0.0.0.0` + tls absent → warn.
- `apps/daemon/src/doctor-routes.test.ts`:
  - `GET /api/doctor returns 200 with a DoctorReport-shaped body`.
  - `report.protocol === "https" when config.tls is set`.
  - `report includes one repo-hooks check per registered repo`.
  - `report.version === 1` always.
- `apps/daemon/src/scaffold-hook-routes.test.ts`:
  - `buildHookScaffoldPrompt embeds the canonical template` (snapshot a substring — guards loader bugs).
  - `buildHookScaffoldPrompt includes the repo name and root path`.
  - `POST returns { reused: false, workspaceId, sessionId } when no in-flight scaffold exists` (mocks `OperationService.launchAgent`).
  - `POST returns { reused: true } when a hook-scaffold-* workspace already exists for the repo`.
  - `404 when repoId is unknown`.
  - Call args assertion: `launchAgent` called with `runtimeId === "claude-code"` and `branchName.startsWith("hook-scaffold-")`.
- `apps/daemon/src/app.test.ts` — extend existing tests:
  - Daemon boots in HTTPS mode when `config.tls` is set (fixture generates self-signed cert).
  - `/api/health` reachable over HTTPS in that mode.
  - WebSocket terminal endpoint reachable over `wss://` (smoke — just an upgrade handshake; tmux/ttyd not exercised).
- `scripts/dev/generate-hook-template.test.ts`:
  - Generator produces byte-for-byte match with committed `assets/hook-templates/citadel-deploy.sh` against current `.citadel/hooks/deploy`.
- `scripts/install/upgrade.test.ts` (vitest, shells out to bash — keeps everything in the existing test harness; no new bats dependency):
  - `REF=v0.3.0` from dirty worktree exits non-zero with stderr naming a dirty path.
  - `REF=v0.3.O` (typo with letter O) exits non-zero on REF regex check.
  - `REF=main` exits non-zero (not an annotated tag).
  - Running from a path other than systemd unit's `WorkingDirectory=` exits non-zero with both paths in stderr.
  - These tests use a tmp-dir fake checkout + fake systemd unit file via `os.tmpdir()` + `fs.writeFileSync`; no real `systemctl` invocation. Picked up automatically by `pnpm test` / `make check`.
- `e2e/diagnostics.spec.ts` — new file:
  - Visits `/settings`, asserts a "Diagnostics" tile present with a status badge.
  - Opens `/settings/diagnostics`, sees one row per registered repo, sees overall summary badge.
  - Mismatched-version banner: when daemon returns `version: 2` (stubbed via test interception), the cockpit renders the "report version unknown" banner.
- `e2e/scaffold-hook.spec.ts` — new file:
  - Boots a daemon with one registered repo and no hooks bound; opens `/settings/repos/<id>`; asserts the empty state shows "Scaffold with AI".
  - Clicks → new workspace appears in the cockpit list with `branchName` matching `hook-scaffold-*`.
  - Returns to `/settings/repos/<id>` → the in-flight banner is visible; the button label is now "Resume scaffold session"; clicking it reuses the existing workspace (verified via the workspace id staying the same).
  - Stubs the underlying Claude Code spawn (existing agent-session e2es do this — re-use the helper).

### Existing tests to update

- `packages/config/src/index.test.ts` — extend an existing fixture to assert `tls === undefined` by default.
- `apps/daemon/src/app.test.ts` — `GET /api/health` body shape: no change; tests merely co-exist with the new doctor-route tests.

### Assertions to add/change/tighten

- `DoctorReport.version === 1` everywhere it's parsed.
- Doctor JSON output round-trips through `JSON.parse(JSON.stringify(...))` without information loss.
- Scaffold-hook prompt embeds the canonical template (snapshot substring).
- HTTPS daemon refuses to listen if the cert is empty (zero-byte) — explicit assertion in app test.
- `make upgrade REF=v0.3.0` from a dirty worktree exits non-zero (shell test).
- WorkingDirectory= mismatch refusal exits non-zero with both paths in the message.
- Hook-template generator output equals the committed asset byte-for-byte.

### Failure modes / edge cases / regression risks

- **Operator runs `make upgrade` while the daemon is serving live sessions.** systemd restart drops every ttyd; the separate tmux unit survives, so agent processes keep running. Doctor's retry behavior masks the brief restart window. Documented in install.md.
- **TLS cert expires.** Daemon refuses to boot; doctor warns within 7 days of expiry. Both paths tested.
- **`CITADEL_INSTALL_REF` set to a non-existent ref.** `git checkout` fails (set -e); upgrade.sh propagates non-zero. Combined with the REF regex check, the failure surfaces before any state-mutating action.
- **AI scaffolder writes a broken hook.** Out of our control once the agent runs. Mitigation: the prompt explicitly says "validate by running `./.citadel/hooks/deploy list` and iterate until JSON parses". The cockpit shows the agent's terminal — operator sees iteration.
- **Concurrent `make upgrade` from two terminals.** Out of scope. systemd serializes; the pid-based stop in install-systemd.sh surfaces collisions.
- **Repo without GitHub remote tries to scaffold.** No issue — the AI scaffolder works on filesystem-only repos. The empty-state button is not gated by `gh` health.
- **Concurrent "Scaffold with AI" clicks.** Resolved by Unit 5's in-flight reuse: the second click reuses the existing scaffold workspace; no duplicates.
- **Scaffold workspace abandoned by operator.** No auto-cleanup. Workspace-cleanup-safety gate respected — dirty trees never auto-deleted. Operator removes via the existing remove-workspace flow if desired. Documented in install.md.
- **Config schema migration.** Adding optional `tls` is purely additive — no existing config breaks. No SQL DDL touched. No `schema_migrations` row.
- **`scripts/install-systemd.sh` regression risk.** Mitigated by `# REF-PIN START / # REF-PIN END` comment markers, by gating new behavior behind `CITADEL_INSTALL_REF`, and by the shared `scripts/lib/install-guards.sh` having its own unit tests (the bash test described above).
- **Doctor false-positive on freshly-restarted daemon.** Mitigated by the 5×1s retry on the daemon-reachability probe.
- **Failed `make check` inside release.yml.** Workflow fails before `gh release create` runs; `install.md` documents the `git push --delete origin <tag>` recovery procedure.

### Adversarial analysis

- **How could this fail in production?**
  Most-likely failure: TLS code paths work in tests with fixtures but break on a real mkcert install because of CA trust expectations. The Node `https` server accepting `{key, cert}` is fine; the cockpit talking to itself over `https://localhost:port` is fine; the failure mode is operator browsers refusing the cert. **Mitigation**: install.md spells out the mkcert + system trust-store step.

- **What user actions could trigger unexpected behavior?**
  Click "Scaffold with AI" while the registered repo's worktree parent is read-only — `launchAgent` already surfaces git errors as `LaunchAgentResult.error`; the cockpit must show that string, not eat it. Verify in the new e2e.

  Run `make upgrade` from a worktree that isn't the systemd-pointed checkout — the new WorkingDirectory= equality check refuses it (Concern F). Verified by the bash test.

  Run `make upgrade REF=v0.3.O` (letter O instead of zero) — REF regex refuses it before any state change. Verified by the bash test.

- **What existing behavior could break?**
  `/api/doctor` is additive. `package.json` version bump cascades through every package — the Unit 2 `rg` audit step catches this. `app.ts` extraction is structural but covered by the existing `app.test.ts` (every test must still pass after the route-module extraction; that's the gate).

- **Which tests credibly catch those failures?**
  See "New tests to add" — daemon HTTPS boot, doctor probes per-kind, scaffold-hook prompt + reuse, e2e for both new flows, bash tests for upgrade safety.

- **What gaps remain?**
  First-run wizard (B.6 AC 1) intentionally not delivered. No automatic upgrade rollback on failed health. No telemetry on scaffold-hook success rate (acceptable — local-first, no telemetry surface today). Doctor diagnoses; it does not gate workspace flows (B.6 AC 5 deferred). All listed in `CHANGELOG.md` Known gaps.

### Architecture-boundary gate compliance

- `packages/contracts/src/doctor.ts` — pure zod types. No code imports.
- `packages/core/src/doctor.ts` — imports only from `@citadel/contracts`. Verified manually + by `pnpm check:arch` post-implementation.
- `packages/operations/src/doctor.ts` — operations may import implementation packages; verified.
- `apps/web/src/routes/settings-diagnostics.tsx` — imports `@citadel/contracts` (the types) only. No daemon-internal imports.
- `apps/cli/src/index.ts` (if doctor subcommand lands) — shells out via `child_process` to `scripts/doctor/run.ts`. No daemon imports.

### File-size gate compliance

- `apps/daemon/src/app.ts` currently 794 lines. Pre-extraction step in Unit 4 moves the server-factory branching out into `apps/daemon/src/server-factory.ts`. New routes (`/api/doctor`, `/api/repos/:repoId/scaffold-hook`) land in separate route-module files (`doctor-routes.ts`, `scaffold-hook-routes.ts`) per the existing `registerXxxRoutes` pattern. Target: `app.ts` ≤ 700 lines after Unit 4 lands. Verified by `wc -l` in implementation TODO; `scripts/checks/file-size.ts` is the CI gate.
- No other file approaches the 800-line limit (`packages/config/src/index.ts` and `apps/web/src/routes/repo-settings.tsx` are both well below).

### Lockfile-sensitivity gate compliance

- **No new dependencies.** `tsx` is already in root `devDependencies` at `^4.19.3` (verified at `package.json:48`). The `crypto` builtin generates self-signed certs in tests — no new deps for test fixtures. No `package-lock.json` / `yarn.lock` introduced.

## Tests

(TDD order — write the unit test before the implementation in each step.)

- `packages/core/src/doctor.test.ts` ← Unit 3, before `core/doctor.ts` impl.
- `packages/contracts/src/index.test.ts` ← Unit 3, extend with `DoctorReport` shape parse tests.
- `packages/operations/src/doctor.test.ts` ← Unit 3, before `operations/doctor.ts` impl.
- `packages/config/src/index.test.ts` ← Unit 4, TLS describe block before schema edit.
- `apps/daemon/src/doctor-routes.test.ts` ← Unit 3, after the core + operations libs.
- `apps/daemon/src/scaffold-hook-routes.test.ts` ← Unit 5, before route impl.
- `apps/daemon/src/app.test.ts` HTTPS additions ← Unit 4, before the server-factory extraction lands.
- `scripts/dev/generate-hook-template.test.ts` ← Unit 5, alongside the generator script.
- `scripts/install/upgrade.test.sh` ← Unit 2, alongside `upgrade.sh`.
- `e2e/diagnostics.spec.ts` ← Unit 3, after the cockpit panel ships.
- `e2e/scaffold-hook.spec.ts` ← Unit 5, after the route + button ship.

## Schema or contract generation

- New types: `DoctorReport`, `DoctorCheck` in `@citadel/contracts`; pure helpers in `@citadel/core`; check runner in `@citadel/operations`. Wire format goes through the daemon route in `apps/daemon/src/doctor-routes.ts`.
- `CitadelConfigSchema` gains optional `tls` (additive). Existing config consumers continue to work because the field is optional.
- No SQL schema changes. No `schema_migrations` row. `PRAGMA foreign_keys = ON;` unaffected.
- No code-generation step — Citadel does not regenerate from a schema artifact today.

## Verification

Before opening the PR, every one of these must pass:

- `make check` — typecheck + Biome + Vitest + coverage + check:arch + check:size + check:deps + build. Architecture gate explicitly re-verified after the three-layer doctor split. File-size gate explicitly re-verified after the `app.ts` extraction.
- `make e2e` — Playwright happy path including the two new specs.
- `make smoke` — touches `/api/health`. New `/api/doctor` is additive; smoke unchanged.
- `make doctor` — runs against the current checkout's `.citadel/data` daemon. Expected status `ok` or `degraded` (depending on provider CLI availability in the dev environment). Document the expected dev-mode output in `install.md`.
- `make performance` — not expected to regress. New routes are not in hot paths.

PR-time manual verification (called out in `/create-pr`'s "How to QA"):

1. `make install` on a fresh clone — confirm citadel.service is up.
2. `make doctor` — confirm all required-binary checks pass on a typical devbox.
3. `CITADEL_INSTALL_REF=v0.3.0 make install` from a dirty worktree — confirm it refuses with a clear dirty-path message.
4. `make upgrade REF=main` — confirm it refuses (not an annotated tag).
5. `make upgrade` from a worktree that isn't the systemd-pointed checkout — confirm it refuses with both paths in the error.
6. Edit `~/.local/share/citadel/citadel.config.json` to add a `tls` block with a self-signed cert; restart citadel.service; confirm `https://localhost:4010/api/health` returns 200; confirm doctor reports `protocol: "https"`.
7. Edit the config to bind `0.0.0.0` without TLS; restart; confirm doctor warns on `bind-host-tls`.
8. Register a repo with no hooks; open Settings → Repositories → that repo; click "Scaffold with AI"; confirm a new workspace appears with branch `hook-scaffold-*` and the agent terminal opens.
9. Click "Scaffold with AI" a second time on the same repo; confirm the existing scaffold workspace is reused (no new branch) and the banner / button label reflect the in-flight state.
10. Tag a release: `git tag v0.3.0 && git push --tags`; verify the release.yml workflow runs `make check` first, then publishes via `gh release create` only on success.
