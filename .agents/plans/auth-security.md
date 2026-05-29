Activate the /implement-task skill first.

# Plan: Auth Security

## Acceptance Criteria

- [ ] Local-only is still attack-surface: anyone reaching the port has shell access
- [ ] Sign-in with Google or GitHub preferred (whichever is easier -- also enables onboarding hooks); user/pass acceptable for v1
- [ ] Cover threat model, first-PR scope, auth enforcement location, token storage/session model, and ambiguous exposure points
- [ ] Produce a credible plan plus a coherent first slice; fully shipped OAuth is not mandatory for this PR

## Context and problem statement

Claude's takeover transcript stopped after architecture discovery. No clarifying answers, auth plan, PR, or feature commits existed. Current `origin/main` exposes Citadel through the daemon boundary: REST API, SSE `/events`, ttyd proxy `/terminals/*`, diagnostic `/terminal/*` WebSocket, static cockpit assets, and HTTP-exposed MCP endpoints. The daemon binds to `127.0.0.1` by default but can be intentionally or accidentally exposed via `CITADEL_BIND_HOST=0.0.0.0`, LAN forwarding, or tunnels. Anyone who can reach the daemon can start sessions, send terminal input, call MCP tools, and mutate local filesystem-backed state.

Conservative assumption for this takeover: ship a v1 local token gate now, defer OAuth/user identity until onboarding requirements are known. The first slice protects the daemon product boundary without adding external identity providers or multi-user state.

## Spec alignment

Relevant specs:

- `specs/A-shared-definitions.md`: Citadel is local-first and daemon-backed; daemon is the product boundary.
- `specs/B.2-ade-cockpit.md`: cockpit is the operator surface and must stay actionable.
- `specs/B.3-agent-sessions-terminal.md`: terminal traffic is routed through the daemon and carries shell access.
- `specs/B.7-operations-activity-mcp.md`: MCP actions use daemon product contracts and can mutate state.
- `specs/C-technical-stack.md`: daemon owns REST/SSE/terminal/MCP surfaces.

Spec update needed first: document the v1 local access gate in `specs/C-technical-stack.md` under backend/API or runtime baseline. No database schema changes.

## Implementation approach

Add daemon-level token authentication enabled by default in real daemon runs:

- Generate or load a per-daemon token from `<dataDir>/auth-token` with `0600` permissions, unless `CITADEL_AUTH_TOKEN` supplies one.
- Expose minimal auth endpoints: `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`.
- Set an HttpOnly, SameSite=Strict cookie after a correct token; accept the cookie, `Authorization: Bearer`, or `X-Citadel-Auth-Token`.
- Protect all daemon routes except auth endpoints and the SPA shell needed to display the login UI.
- Protect terminal WebSocket upgrades for both `/terminals/*` and diagnostic `/terminal/*`.
- Add a web login gate that checks `/api/auth/status`, renders a compact token form when unauthenticated, and then lets the existing router boot normally.

Tests can explicitly disable auth in existing route fixtures to avoid rewriting every unrelated route test. New targeted tests will instantiate the app with auth enabled and verify protected REST, SSE, MCP, terminal HTTP, and WebSocket paths reject unauthenticated requests and accept valid credentials.

## Alternatives considered

OAuth with GitHub or Google was deferred. It solves identity and onboarding hooks later, but it adds redirect flows, app registration, callback URLs, provider secrets, and tunnel/localhost edge cases before the core daemon exposure is protected.

User/password was deferred. It still needs password hashing, recovery/reset semantics, and user storage. For a local single-operator daemon, a generated local token is smaller and avoids a database migration.

Binding only to `127.0.0.1` was rejected as the only control. Citadel already supports bind-host override and local web pages, tunnels, or port forwards can still reach localhost-bound services from the operator machine.

## Implementation steps

### Specs

- Update `specs/C-technical-stack.md` to describe the v1 local token gate and the protected surfaces.

### Daemon Auth

- Add `apps/daemon/src/auth.ts` with token loading/generation, cookie parsing, login/logout handlers, request middleware, and reusable upgrade authorization helpers.
- Wire auth in `apps/daemon/src/app.ts` immediately after JSON middleware and before terminal/MCP/API/static route registration.
- Pass an auth upgrade predicate into ttyd and diagnostic terminal WebSocket wiring.
- Add startup logging in `apps/daemon/src/index.ts` that names the token file path without printing the token.

### Web Login Gate

- Update `apps/web/src/api.ts` to use same-origin credentials.
- Add a small login gate component to `apps/web/src/main.tsx` or an adjacent module that checks auth status before rendering the router.
- Add CSS for the token form consistent with the cockpit chrome.

### Tests

- Add daemon auth tests in `apps/daemon/src/auth.test.ts` or `apps/daemon/src/app-auth.test.ts`.
- Update shared daemon test fixtures to disable auth by default only for unrelated tests.
- Add web unit coverage for the login gate if extracted into a testable component; otherwise rely on daemon tests plus typecheck/build.

## QA/Test Strategy

Unit (Vitest): Tests must be added. Verify token file generation/reuse, cookie login/logout, unauthorized 401 JSON for `/api/state` and MCP, public `/api/auth/status`, bearer/header token acceptance, and 401 WebSocket upgrade response for terminal paths. Update existing daemon fixtures to disable auth outside focused tests with a clear helper option.

E2E (Playwright): Not required for this first slice. The diff changes the daemon HTTP contract, but local auth prompts would require broader fixture login support across every e2e spec. Risk is covered by targeted daemon tests plus `pnpm build`; full e2e can be added after a stable auth helper is agreed.

Failure modes and regression risks:

- Auth middleware accidentally blocks the login/status endpoints; daemon tests cover this.
- Middleware protects REST but misses WebSocket upgrades; targeted upgrade tests cover `/terminals/*` and `/terminal/*`.
- Cookie is not sent by web fetches; `credentials: "same-origin"` and web build/typecheck cover the client integration.
- Existing unrelated daemon tests fail because auth is on; test fixtures disable auth explicitly.
- The token leaks into logs or JSON status; tests and code review check that only token path is exposed.

Remaining gap: no TLS and no OAuth. A passive network attacker on a non-TLS tunnel could steal the session cookie. This PR is a local-first access gate, not a public internet auth system.

## Tests

- `apps/daemon/src/app-auth.test.ts`
- `apps/daemon/src/app-test-helpers.ts` fixture update
- Existing daemon route tests through the shared fixture

## Schema or contract generation

No schema or generated contract step. No database changes.

## Verification

- `pnpm vitest run apps/daemon/src/app-auth.test.ts`
- `pnpm vitest run apps/daemon/src/app.test.ts`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `make check`
- `pnpm smoke` with a running daemon, because the daemon HTTP surface changes
