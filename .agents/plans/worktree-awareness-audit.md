Activate the /implement-task skill first.

# Plan: Worktree awareness audit

## Acceptance Criteria

- [ ] The full path from cockpit UI → daemon → ttyd → providers is documented for the worktree-dev scenario, with file:line citations for every "isolation point" (port derivation, env var pinning, env scrub, config-path resolution).
- [ ] Every `:4010` reference under **production code paths** (`apps/`, `packages/`, `scripts/`) is classified as either (a) "systemd-only path, intentional" or (b) "fixed because it could leak under worktree-dev". Docs/README hits are out of scope (they describe the systemd port by design — see Spec alignment below for the full disposition).
- [ ] The lone production-code leak found by the audit — the SSR fallback in `apps/web/src/routes/settings.tsx:433` that hard-codes `http://127.0.0.1:4010/api/mcp/rpc` — is removed. The MCP URL is computed by a pure helper that takes the browser origin as input.
- [ ] A regression test exists that fails both (a) when the helper does not include the supplied origin, and (b) when `settings.tsx` re-introduces the literal `127.0.0.1:4010` anywhere in its source text.
- [ ] `docs/operations/worktree-development.md` gains a short "Worktree isolation: how it works" subsection that lists the five hard isolation points so future contributors do not regress them, plus the classification of every production-code `:4010` reference.
- [ ] `make check` passes (typecheck, lint, vitest unit + coverage, build, arch boundaries, size, deps).

## Context and problem statement

Citadel is a local-first cockpit. A long-term `citadel.service` systemd unit binds port `4010`; per-worktree `make deploy` stacks bind derived ports in `4110–4209` (daemon) + `5210–5309` (vite). The documented failure mode (`docs/operations/worktree-development.md` § "Why this is the shape") is: a developer opens a worktree, runs `pnpm dev`, vite proxies `/api` to the default `http://127.0.0.1:4010`, and the cockpit silently talks to the *systemd* daemon — which is running a different branch. New backend routes 404 even though they exist in the worktree.

The full request path has four hops, each of which has its own isolation contract:

1. **Cockpit UI → daemon.** Browser hits vite (5210–5309); vite proxies `/api`, `/events`, `/terminals`, `/terminal` to `CITADEL_DAEMON_URL` (set by `make deploy` to `http://127.0.0.1:<worktree-daemon-port>`).
2. **Daemon → ttyd.** Daemon spawns one ttyd per terminal session, in a per-daemon port slot derived from `(((config.port - 4010) % 11) + 11) % 11` × 200 (apps/daemon/src/app.ts:101 — note: slot width was widened from 20 to 200 in commit a1a583a).
3. **ttyd → provider.** ttyd execs a tmux wrapper (`packages/terminal/src/index.ts`) that ultimately runs the runtime command (e.g. `claude`) in the workspace's cwd, inheriting the daemon's environment.
4. **Provider → daemon (MCP).** A provider that wants to talk back into Citadel uses the MCP URL the user pastes from the cockpit's Settings → MCP panel.

The goal of this task is to verify that no hop can leak across worktrees, and to fix the one leak the audit found.

### What the audit found

| # | Hop | Status | Detail |
|---|---|---|---|
| 1 | Vite proxy | CLEAN | `apps/web/vite.config.ts:21-31` reads `CITADEL_DAEMON_URL` for every proxy target; the `\|\| "http://127.0.0.1:4010"` fallback only fires when the env var is absent, which is intentional for the "bare `pnpm dev` against the systemd daemon" workflow. The `make deploy` Makefile always sets `CITADEL_DAEMON_URL` explicitly. |
| 2 | Frontend daemon URLs | LEAK | `apps/web/src/routes/settings.tsx:433` hard-codes `http://127.0.0.1:4010/api/mcp/rpc` as an SSR fallback. The cockpit is an SPA so the branch is dead at runtime, but it's a copy-paste hazard and a future SSR/prerender step would silently emit a URL pointing at the systemd daemon. |
| 3 | WebSocket / EventSource | CLEAN | All `EventSource("/events")` and ttyd `ws://…/terminals` calls are relative; they ride the vite proxy. |
| 4 | ttyd spawn | CLEAN | `packages/terminal/src/ttyd.ts:137` spawns ttyd bound to `-i 127.0.0.1`, port from per-daemon slot. No URL embedded. |
| 5 | Provider launch | CLEAN-by-inheritance | `packages/operations/src/create-agent-session.ts:46-51` calls `ensureTmuxSession` with the workspace cwd and no explicit env. The child inherits the daemon's env, which has already been worktree-validated by `apps/daemon/src/index.ts:26-43` (rejects `CITADEL_CONFIG`/`CITADEL_DATA_DIR` that point outside the worktree). |
| 6 | State files | CLEAN | `.citadel/dev.json` is always resolved against `worktreeRoot` (`packages/config/src/dev-state.ts:21`). `CITADEL_DATA_DIR` is forced to `${worktreeRoot}/.citadel/data` for worktree daemons. |
| 7 | MCP/contracts base URLs | LEAK (same as #2) | The only MCP client URL emitted is the one in `settings.tsx:433`. |
| 8 | CLI | N/A | `apps/cli/src/index.ts` is currently a stub. |
| 9 | Makefile env scrub | CLEAN | `Makefile:145-157` `env -u`s every `CITADEL_*` var, then sets `CITADEL_WORKTREE=1` plus the four worktree-pinned values. |
| 10 | Grep `:4010` on production code | See classification table below. | |

### Classification of every `:4010` reference (production code only)

| File:line | Code | Verdict |
|---|---|---|
| `apps/web/vite.config.ts:21,22,25,31` | `process.env.CITADEL_DAEMON_URL \|\| "http://127.0.0.1:4010"` | Intentional. Bare `pnpm dev` (no `make deploy`) is a supported workflow; the fallback routes to the systemd daemon. `make deploy` always sets the env var. Keep. |
| `apps/web/src/routes/settings.tsx:433` | `: "http://127.0.0.1:4010/api/mcp/rpc"` | **Fix.** SSR branch in an SPA — dead code today, but a copy-paste / future-SSR hazard. |
| `apps/daemon/src/app.ts:95,101,130` | Slot math + comment | Intentional. The slot derivation uses `4010` as the modular origin so the systemd daemon and worktree daemons land in disjoint ttyd port slots. Keep. |
| `apps/daemon/src/index.ts:8,49` | Comment + error message | Intentional. Refuses to bind `:4010` from a worktree daemon. Keep. |
| `packages/config/src/index.ts:76` | `port: …default(4010)` | Intentional. Schema default for the systemd unit. Keep. |
| `scripts/dev/smoke.ts:1`, `scripts/dev/performance-smoke.ts:8` | `process.env.CITADEL_BASE_URL \|\| "http://127.0.0.1:4010"` | Intentional. Smoke scripts target the systemd daemon by default; overridable via env var. Keep. |
| `scripts/install-systemd.sh:45,48` | `Environment=CITADEL_PORT=4010` | Intentional. Systemd unit. Keep. |
| `packages/config/src/index.test.ts:219,227,262,269` | Test fixtures | Intentional. Test data. Keep. |

Out-of-scope hits (docs/README — they describe the systemd port by design, not a leak): `README.md:12`, `docs/operations/runbook.md:10,98,107,110,113`, `docs/operations/worktree-development.md:83,105`, `docs/operations/config-reference.md:154`, `docs/campaigns/spec-traceability.md:99`, `specs/B.8-ui-performance-quality.md:70`. None are leaks; the docs deliberately document the systemd port to help operators troubleshoot misroutes.

## Spec alignment

Per `.agents/skills/extensions/review-pr.md` "Spec mappings":

- `apps/web/**` → `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md`
- `apps/daemon/src/**`, `packages/terminal/**` → `specs/B.3-agent-sessions-terminal.md`
- Infrastructural docs (`docs/operations/worktree-development.md`) → `specs/C-technical-stack.md`

Spec gate check (per Citadel review-tech-plan extension):
- Grepped `specs/B.2-ade-cockpit.md`, `specs/B.3-agent-sessions-terminal.md`, `specs/B.8-ui-performance-quality.md` for "MCP", "McpSection", "settings", "127.0.0.1", "worktree isolation", "4010". The only hit is `specs/B.8-ui-performance-quality.md:70` — an open `[~]` AC about playwright tests using isolated ports that "cannot collide with the operator's dev daemon (4010) or web (5175)". That AC is about playwright/E2E isolation, NOT about the SPA's MCP URL string; the fix in this plan does not advance it. No other spec covers the MCP example URL string, the vite proxy fallback, or worktree isolation as a behavioral contract.
- Conclusion: no spec items are advanced or violated. No spec file changes. The classification table above lives in `docs/operations/worktree-development.md` (operational documentation), which is the canonical home for the "how worktree dev avoids talking to the wrong daemon" runbook material.

## Implementation approach

Four small changes, in this order:

1. **Extract the MCP URL into a pure helper.** Create `apps/web/src/lib/mcp-url.ts` exporting a one-line `mcpUrlFromOrigin(origin: string): string` that returns `\`${origin}/api/mcp/rpc\``. Pure function, no DOM dependency, trivially testable. This pattern matches the repo's existing helper-and-test layout (`apps/web/src/lib/last-route.ts`, `apps/web/src/lib/usage-format.ts` with their colocated `.test.ts`).

2. **Replace the dead-branch fallback in `settings.tsx`.** Drop the `typeof window !== "undefined" ? … : …` ternary. Call `mcpUrlFromOrigin(window.location.origin)` directly. The `window.location.origin` access stays inside `McpSection`'s function body (lazy at render time), so module-load under a node-env import won't throw — only rendering the component does. This avoids the failure mode where a future test importing the route file would crash at module load.

3. **Add the regression test.** `apps/web/src/lib/mcp-url.test.ts` (matches the repo's `*.test.ts` vitest glob from `vitest.config.ts:5`). Two layers of guard:
   - **Helper unit test** — `expect(mcpUrlFromOrigin("http://localhost:5273")).toBe("http://localhost:5273/api/mcp/rpc")` and a negative `.not.toContain("4010")`. This is a positive correctness test of the helper.
   - **Source-file regression check** — read `apps/web/src/routes/settings.tsx` from disk via `readFileSync(new URL("../routes/settings.tsx", import.meta.url), "utf8")` and assert the text does NOT match `/127\.0\.0\.1:4010/`. This is the only assertion that catches a future copy-paste re-introducing the literal in *any* code path (dead or live). Tested-against-current-source-on-disk is the only correct way to guard against dead-branch resurrection.

4. **Add the "Worktree isolation: how it works" subsection** to `docs/operations/worktree-development.md` (between "Ports and storage" and "Typical flows"). The subsection lists the five hard isolation points by file:line:
   - Makefile env scrub (`Makefile:145-157`)
   - Daemon env validation (`apps/daemon/src/index.ts:26-43`)
   - Daemon refusal to bind `:4010` (`apps/daemon/src/index.ts:47-52`)
   - ttyd slot disjointness (`apps/daemon/src/app.ts:95-101`)
   - Vite proxy reads `CITADEL_DAEMON_URL` (`apps/web/vite.config.ts:21-32`)

   It also inlines the production-code `:4010` classification table (verbatim from this plan) so a contributor doesn't "clean up" a 4010 reference and break the systemd path.

Nothing else touches code. The helper extraction is one tiny file, the test is one tiny file, the route edit is one line shorter than today, and the docs add ~30 lines.

## Alternatives considered

- **Alternative A: Replace `apps/web/vite.config.ts`'s `4010` fallback with a hard error when `CITADEL_DAEMON_URL` is unset.** Rejected. Breaks the "bare `pnpm dev` while developing UI only" workflow that uses the systemd daemon as a data source. The Citadel quick-reference (`CLAUDE.md` at repo root) only documents `make deploy` as the supported dev command, but bare `pnpm dev` is occasionally useful, and the 4010 default is doing exactly what it should there.

- **Alternative B: Have the daemon serve the MCP URL via an API endpoint.** Rejected as over-engineered. `window.location.origin` is exactly the right answer: the cockpit is opened in a browser, the URL an external MCP client (on the same machine) should use is whatever the user typed into their browser bar.

- **Alternative C: Make the SSR fallback compute from a build-time env var.** Rejected. There is no SSR. Adding build-time wiring for a code branch that never executes is pure waste.

- **Alternative D: Keep the change inline in `settings.tsx` (no helper extraction) and only do the source-file regex assertion.** Rejected. The helper adds one trivial file and makes the test pure (no DOM stubbing, no JSX render dance, no `happy-dom` environment guard). The repo's existing test pattern (`apps/web/src/lib/last-route.test.ts`, etc.) is to extract helpers and unit-test them; this fix should match. The source-file regex is still included as defense-in-depth.

- **Alternative E: Add `.test.tsx` to the vitest include glob and render `<McpSection />` via `@testing-library/react`.** Rejected. The repo's existing convention is `.test.ts` only (`vitest.config.ts:5`), no `@testing-library/react` is currently in `apps/web` deps, and a JSX-render test would require stubbing `window.location` (a getter on `Window.prototype` that requires `Object.defineProperty(window, 'location', { configurable: true, value: {…} })` to override safely under happy-dom). The pure-helper alternative sidesteps all of that.

## Implementation steps

### Code (in TDD order)
- **Step 1 (test first).** Create `apps/web/src/lib/mcp-url.test.ts`:
  - Test 1: `mcpUrlFromOrigin returns origin + /api/mcp/rpc` — `expect(mcpUrlFromOrigin("http://localhost:5273")).toBe("http://localhost:5273/api/mcp/rpc")`.
  - Test 2: `mcpUrlFromOrigin never embeds the systemd port` — call with several origins, assert `.not.toContain("4010")` and `.not.toContain("127.0.0.1")` on each result.
  - Test 3: `settings.tsx does not embed the systemd daemon URL as a literal` — read `apps/web/src/routes/settings.tsx` from disk, assert `.not.toMatch(/127\.0\.0\.1:4010/)`.
  - Step 1 ends with `pnpm vitest run apps/web/src/lib/mcp-url.test.ts` (from repo root) failing on Test 1 (helper doesn't exist) and Test 3 (literal currently exists in `settings.tsx:433`).
- **Step 2.** Create `apps/web/src/lib/mcp-url.ts` exporting `export function mcpUrlFromOrigin(origin: string): string { return \`${origin}/api/mcp/rpc\`; }`. Test 1 + Test 2 pass. Test 3 still fails.
- **Step 3.** Edit `apps/web/src/routes/settings.tsx`:
  - Add `import { mcpUrlFromOrigin } from "../lib/mcp-url.js";` (matching the repo's `.js` extension convention on internal imports — confirm by reading existing imports in the file).
  - In the `McpSection` function around line 431, replace the two-line `const mcpUrl = typeof window !== "undefined" ? … : "http://127.0.0.1:4010/api/mcp/rpc";` with `const mcpUrl = mcpUrlFromOrigin(window.location.origin);`.
  - Test 3 passes.

### Docs
- **Step 4.** Edit `docs/operations/worktree-development.md`: insert a new H2 "Worktree isolation: how it works" between "Ports and storage" and "Typical flows" with:
  - Five-bullet list of isolation points (file:line citations as listed in "Implementation approach").
  - The production-code `:4010` classification table (verbatim from this plan) under an H3 "Where `:4010` legitimately appears".
  - A one-line note: "Doc/README references to `:4010` describe the systemd port for operators — they are not leaks."

### Public surface change
- New module: `apps/web/src/lib/mcp-url.ts` exporting `mcpUrlFromOrigin(origin: string): string`. Trivial, isolated, no consumers outside `settings.tsx`.
- `McpSection` in `settings.tsx` remains an internal (non-exported) function — the test goes through `mcpUrlFromOrigin` + source-file regex instead of rendering the component, so no export change is needed.

No schema changes. No new dependencies. No config changes. No new cross-package imports (the helper is intra-package, `apps/web/src/lib/...` → `apps/web/src/routes/...`).

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | One new test file `apps/web/src/lib/mcp-url.test.ts` with three tests: helper correctness, helper never returns the systemd port, source-file regex regression on `settings.tsx`. |
| E2E (Playwright) | Not required | The fix is a dead-code removal + helper extraction; the user-visible behavior (cockpit-rendered MCP example URL) is byte-identical when JS is running in a browser. Unit + source-regex is strictly more precise than an E2E click-into-Settings. |

### New tests to add
- `apps/web/src/lib/mcp-url.test.ts`:
  - `mcpUrlFromOrigin returns origin + /api/mcp/rpc` — positive correctness of the helper.
  - `mcpUrlFromOrigin never embeds the systemd port` — defensive: any origin input, output must not contain `4010` or `127.0.0.1`.
  - `settings.tsx does not embed the systemd daemon URL as a literal` — `readFileSync` on the source file, assert no `/127\.0\.0\.1:4010/` match.

### Existing tests to update
- None. Searched `apps/web/src/**/*.test.ts` (`grep -l "settings\|McpSection\|mcpUrl"`) — no existing test covers the MCP example URL string. New file is justified per the "prefer extending existing tests" rule because no existing test covers this area.

### Assertions to add/change/tighten
- Add: `expect(mcpUrlFromOrigin("http://localhost:5273")).toBe("http://localhost:5273/api/mcp/rpc")`.
- Add: `for (const origin of ["http://localhost:5273", "https://citadel.example", "http://10.0.0.5:4209"]) expect(mcpUrlFromOrigin(origin)).not.toContain("4010")`.
- Add (same loop): `.not.toContain("127.0.0.1")` (proves the helper preserves the input host, never injects loopback).
- Add: `expect(readFileSync(new URL("../routes/settings.tsx", import.meta.url), "utf8")).not.toMatch(/127\.0\.0\.1:4010/)`.

### Failure modes / edge cases / regression risks
- **Helper resurrects a hardcoded URL** — caught by the negative loop assertion (would fail on any input).
- **`settings.tsx` re-introduces `127.0.0.1:4010` in any branch (dead or live)** — caught by the source-file regex test.
- **`window` is undefined under a future SSR introduction** — `McpSection` now calls `window.location.origin` directly at render time (not at module load). It throws on render under SSR, which is the correct loud failure. The helper itself is pure and SSR-safe.
- **A test imports `settings.tsx` at module load in a node env** — `mcpUrlFromOrigin` is not invoked at module load; `window.location.origin` access is inside the function body. Module load is safe in node. (Verified by reading the proposed code shape.)
- **Vite proxy `4010` fallback gets removed by mistake** — out of scope for this audit; fallback is intentional. Future PRs touching `vite.config.ts` would need a separate review.

### Adversarial analysis
- **How could this fail in production?** It can't — the line we're removing is unreachable in production (SPA, no SSR). The risk we're removing is "silent misroute under a hypothetical future SSR pass" plus "a developer greps the codebase and copy-pastes the stale string."
- **What user actions trigger unexpected behavior?** None. Cockpit users in a browser see the same URL string they always have.
- **What existing behavior could break?** Any code path that imports `McpSection` from a Node context without happy-dom and *renders* it. None exist today.
- **Which tests credibly catch those failures?** The helper unit test verifies positive behavior. The source-file regex catches dead-branch resurrection. Neither tries to assert on SSR-failure-throws, which is correctly framed as "we want it to fail loudly if anyone introduces SSR."
- **What gaps remain?** Bare `pnpm dev` (no `make deploy`) still silently routes the cockpit at the systemd daemon — intentional behavior, but a new contributor might be surprised. The new docs subsection makes this explicit so the surprise is one grep away.

## Hard gates checklist

- **Spec gate** (APPLIES — bug fix). Result: grepped relevant specs, confirmed no spec items are advanced/violated. Documented in "Spec alignment" above. No spec files changed.
- **Regression test gate** (APPLIES — bug fix). Result: new test file added because no existing test covers this area (search documented in "Existing tests to update"). Two assertion layers (helper unit + source-file regex) catch both forward correctness and dead-branch resurrection.
- **Architecture-boundary gate** (SKIP — no new cross-package imports; helper is intra-`apps/web`).
- **Schema-safety gate** (SKIP — no `packages/db/` changes).
- **File-size gate** (APPLIES always). Result: no file approaches the 800-line limit. `settings.tsx` shrinks by one line; `mcp-url.ts` is ~3 lines; `mcp-url.test.ts` is ~25 lines; docs add ~30 lines to a file currently ~115 lines.
- **Provider-degradation gate** (SKIP — no `@citadel/providers` changes).
- **Workspace-cleanup-safety gate** (SKIP — no workspace lifecycle).
- **Terminal-completeness gate** (SKIP — no terminal code).
- **Lockfile-sensitivity gate** (SKIP — no `package.json`/`pnpm-lock.yaml` changes).

## Tests

Order is dictated by Implementation steps (TDD): write `mcp-url.test.ts` first (fails on Test 1 + Test 3), then create `mcp-url.ts` (Tests 1 + 2 pass), then edit `settings.tsx` (Test 3 passes).

## Schema or contract generation

Not applicable.

## Verification

- `pnpm vitest run apps/web/src/lib/mcp-url.test.ts` (from repo root) — confirms the new test runs and passes. The web workspace has no `test` script in `apps/web/package.json:scripts`, so vitest must be invoked from the repo root using the root `vitest.config.ts` whose include glob (`apps/*/src/**/*.test.ts`) picks up the new file.
- `make check` — must pass (typecheck, lint, vitest unit + coverage, build, arch boundaries, size, deps). This is the comprehensive local gate before opening the PR.
- `make e2e` — not required; no user-visible behavior change in the browser.
- `make smoke` / `make performance` — not required; the change does not touch the daemon's HTTP surface or hot paths.
