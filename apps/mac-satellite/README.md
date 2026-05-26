# @citadel/mac-satellite

Native macOS satellite app built on Electron. Registers two global shortcuts and uses the local Citadel daemon's web surfaces — no new endpoints, no shared state, no codesigning required for personal use.

| Shortcut | Action |
|---|---|
| `⌘⇧S` | Open a Spotlight-shaped frameless popup loading the daemon's `GET /quick-capture` page. ⌘+Enter saves a new block; Esc closes. |
| `⌘⇧N` | Open the cockpit at `/?modal=new-workspace` in your default browser — the cockpit auto-opens the Create Workspace modal. |

## Run

```sh
pnpm --filter @citadel/mac-satellite dev
```

That launches Electron and registers the shortcuts. The app runs in the background (no Dock icon, no menu-bar item) and stays alive until you `pkill` it or sign out — that's the whole point of a satellite app.

## Configuration

Daemon target defaults to `127.0.0.1:4010` (the long-term systemd daemon). Override via env:

```sh
CITADEL_HOST=127.0.0.1 CITADEL_PORT=4150 pnpm --filter @citadel/mac-satellite dev
```

Worktree-isolated daemons (4110+) are intentionally **not** auto-discovered — a globally-bound shortcut can't infer which worktree is "active", and silently picking one would be a footgun. Set `CITADEL_PORT` explicitly if you want the satellite bound to a specific worktree.

## Trust model

Citadel is single-user / localhost-first. The daemon binds `127.0.0.1` by default with CORS allow-all and no per-request authentication. This app does not change that posture — it's a convenience layer over an already-open localhost HTTP surface. If you expose the daemon to a LAN, you own the network gate (SSH tunnel, VPN, auth-adding proxy).

## Why Electron and not Tauri

Tauri would ship a smaller binary, but it needs a Rust toolchain in CI and adds platform-specific build complexity. The satellite is ~200 lines of TypeScript and the Electron `globalShortcut` API does exactly what we need. We chose simplicity. Revisit if startup time or memory footprint becomes a problem.

## Packaging

This package does not yet produce a `.app` bundle — the dev flow above is sufficient for personal use and CI verification (TypeScript compile + unit tests on the config helpers). Adding `electron-builder` for a signed/notarized `.app` is a follow-up; bring it up when the dev flow isn't enough.

## What's tested

- `src/config.ts` — daemon target resolution, env-var precedence, fallback semantics, Spotlight-popup geometry with multi-monitor offsets. See `src/config.test.ts`.
- `src/main.ts` — Electron-internal; not unit-testable as written. Verify manually via `pnpm --filter @citadel/mac-satellite dev`.

## Shell-script fallback

If you'd rather not run an Electron process: see [`scripts/mac-satellite/`](../../scripts/mac-satellite/). The scripts wrap the same daemon URLs and bind via Hammerspoon or Shortcuts.app.
