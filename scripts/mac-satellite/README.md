# Citadel — Mac satellite shortcuts

Two tiny shell helpers that turn the local Citadel daemon's web surfaces into
Spotlight-style global-shortcut targets. Both target the long-term systemd
daemon on `127.0.0.1:4010` by default.

| Script | What it does | Suggested shortcut |
|---|---|---|
| `quick-capture.sh` | Opens `GET /quick-capture` in a chromeless 640×220 popup. Type a thought, mic-dictate it, ⌘+Enter to save into the scratchpad as a new block, Esc/⌘W to dismiss. | `⌘+⇧+S` |
| `new-workspace.sh` | Opens `/?modal=new-workspace` in the user's default browser. Cockpit auto-opens the Create Workspace modal. | `⌘+⇧+N` |

> These scripts are intentionally **not** wired into `make check` — they
> depend on macOS-only tooling (`open`, `osascript`, AppleScript, Chrome
> `--app=`) that cannot run in Linux CI.

## Prerequisite

The Citadel daemon must be running and reachable. The default target is the
long-term systemd daemon on `127.0.0.1:4010` (see `make install`).

## Trust model

Citadel is a **single-user, local-first** tool. The daemon binds `127.0.0.1`
by default with CORS allow-all and no per-request authentication —
`POST /api/scratchpad/blocks` (which the quick-capture page submits to) is
unauthenticated by design. These scripts do not change that posture; they're
a convenience layer over an already-open localhost surface. If you've
configured the daemon to bind a LAN address or you tunnel/forward the port,
you own the corresponding network gate (SSH tunnel, VPN, auth-adding proxy).

## Worktrees

The shortcuts target **one** daemon — the long-term systemd one. Worktree
daemons (port `4110–4209` per CLAUDE.md) are deliberately NOT auto-discovered:
a global shortcut bound at the OS level can't know which worktree is "active",
and silently picking one would be a footgun. If you want a shortcut bound to
a specific worktree, set `CITADEL_PORT` (and optionally `CITADEL_HOST`) in
the shortcut's environment — Hammerspoon and Shortcuts.app both support env
overrides per binding.

## Wiring the shortcut — Hammerspoon (recommended)

[Hammerspoon](https://www.hammerspoon.org/) is a free macOS automation tool.
After installing it and granting Accessibility permission, drop this into
`~/.hammerspoon/init.lua`:

```lua
local function run(cmd)
  return function() hs.execute(cmd, true) end
end

local repo = os.getenv("HOME") .. "/path/to/citadel"

-- ⌘ + Shift + S → quick-capture popup
hs.hotkey.bind({"cmd", "shift"}, "s", run(repo .. "/scripts/mac-satellite/quick-capture.sh"))

-- ⌘ + Shift + N → new-workspace
hs.hotkey.bind({"cmd", "shift"}, "n", run(repo .. "/scripts/mac-satellite/new-workspace.sh"))
```

Then `Reload Config` from Hammerspoon's menu bar icon. Done.

## Wiring the shortcut — Shortcuts.app (fallback)

If you'd rather not install Hammerspoon:

1. Open **Shortcuts.app** → ➕ to create a new shortcut.
2. Add a **Run Shell Script** action. Set the script to the absolute path of
   `quick-capture.sh`. Set Shell to `/bin/sh`.
3. Name the shortcut `Citadel Quick Capture`.
4. Click the ⓘ (info) panel → **Add Keyboard Shortcut** → press `⌘+⇧+S`.
5. Repeat for `new-workspace.sh` with `⌘+⇧+N`.

Shortcuts.app shows a brief macOS-style banner when the shortcut runs, which
is harmless but visible. Hammerspoon is silent — that's why it's the
recommendation.
