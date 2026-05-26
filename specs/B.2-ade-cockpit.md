# [B.2] ADE Cockpit

**Status:** Draft

> The cockpit is the main operator surface. It answers what needs attention now.

## First Screen

[ ] 1. The first screen answers: what is running, what is blocked, what needs review, what changed, and what can I do next?
[ ] 2. Citadel feels like a dense operator cockpit.
[ ] 3. The selected workspace shows readiness before deep details.
[ ] 4. Readiness explains blockers, stale data, missing providers, failed hooks, and available next actions.
[ ] 5. The cockpit combines session, terminal, git, PR, CI, Jira, diff, apps, actions, operations, and activity context.
[ ] 6. The cockpit makes review/fix/deploy/wait decisions obvious from the selected workspace.
[ ] 7. The cockpit uses a dark-blue v1-inspired palette and stays dense, with no marketing-style hero areas.

## Shell Layout

[ ] 1. The cockpit shell is a three-column layout: navigator (left), agent stage (center), inspector (right).
[ ] 2. Both side columns are independently resizable via drag handles between columns.
[ ] 3. Both side columns are independently collapsible.
[ ] 4. The left collapse control sits on the same row as the `Dashboard` link inside the navigator's primary nav. The right collapse control lives in the top-left corner of the inspector.
[ ] 5. When a side column is collapsed, the column disappears entirely but its expand affordance remains visible so it can be reopened.
[ ] 6. The center column always takes the remaining horizontal space.
[ ] 7. The application shell never page-scrolls. Each column owns its own scroll context.
[ ] 8. Terminal scrollback stays inside the terminal renderer, not the column scroll.
[ ] 9. A slim top bar contains the product mark on the left, a centered search input that opens the command palette via click or Cmd+K, and the settings entry on the right. The product mark appears exactly once across the chrome — the navigator does not duplicate it.
[ ] 10. Resizable widths and collapse state persist locally between sessions.
[ ] 11. No bottom status bar is rendered in the cockpit; operations, MCP, and activity counts are surfaced from their dedicated panels and command-palette navigation only.
[ ] 12. The left navigator devotes its entire vertical space below primary nav to the workspaces list, which scrolls independently when content exceeds the column height.
[ ] 13. Icon-only controls expose a native tooltip (title) and accessible label that describes their action or target.
[ ] 14. Top-layer modals and overlays (command palette, create workspace, add repo) are centred both horizontally and vertically in the viewport; backdrop dismissal and `Esc` close them.

## Keyboard Shortcuts

[x] 1. Global cockpit shortcuts:
   - `Cmd/Ctrl+K` — opens the command palette.
   - `Ctrl+N` (mac only; Linux/Windows browsers reserve it for "new browser window") and plain `c` (when no editable target is focused) — opens the new-workspace modal.
   - `Ctrl+1`…`Ctrl+9`, `Ctrl+0` — jump to the Nth workspace in the Navigator's in-tree visible order (0 = 10th). If the workspace is inside a collapsed group, the group auto-expands. On Chrome/Edge/Firefox on Windows and Linux, `Ctrl+1..9` is browser-reserved (switches browser tabs) — these shortcuts work reliably only on macOS or inside a PWA/desktop wrapper.
   - `Cmd+Shift+1`…`Cmd+Shift+9` — jump to the Nth session in the active workspace's Center Stage tab strip, ordered by session `createdAt` ascending.
   - `Cmd+T` — spawn a new bare Terminal session in the active workspace. Browser-reserved in normal tab mode on every major desktop browser; works in Safari "Add to Dock" standalone PWAs and dedicated wrappers (Electron/Tauri). Chrome PWA window mode does NOT free it on macOS in current builds.
   - `Cmd+E` — spawn a new agent session in the active workspace using the workspace's default agent runtime (currently resolved as: prefer `claude-code` if healthy, else first healthy non-`shell` runtime). Collides benignly with Chrome/Safari "Use Selection for Find" on macOS — the cockpit handler `preventDefault`s before the browser acts, since `Cmd+E` is a renderer-level editing shortcut, not a window-management shortcut.
   - `Escape` — closes the top-most open overlay (command palette, modal, dialog).
[x] 2. When focus is inside a terminal iframe (ttyd-rendered xterm), the iframe shim forwards the chords above to the cockpit instead of consuming them locally. `Escape` is forwarded ONLY when at least one cockpit overlay is open (the shim reads a ref-count exposed by the cockpit); otherwise xterm receives `Escape` unmodified so vim/Claude Code work normally. All other keystrokes pass through to xterm as today.

## Dashboard

[ ] 1. Dashboard groups workspaces by the same operator-facing workspace section/status used by workspace cards, not derived labels such as dirty.
[ ] 2. Dashboard workspace cards have fixed compact height and never stretch to fill the entire column.
[ ] 3. Working/in-progress state is reserved for active operations or explicit active agent statuses. A plain terminal or an idle open agent tab must not mark the workspace as working.

## Center Stage Sessions

[ ] 1. The center column shows the workspace's sessions/chats as tabs along the top.
[ ] 2. A plus button next to the tabs adds a new session: pick a plain `Terminal` or one of the configured agent runtimes. The button is rendered immediately to the right of the last tab (not pushed to the far edge), and the button + menu sit outside the horizontally scrollable tab strip so the menu is never clipped. Keyboard equivalents are `Cmd+T` (Terminal) and `Cmd+E` (default agent runtime); the menu item next to each runtime displays the chord.
[ ] 3. Selecting `Terminal` creates an empty shell session in the workspace worktree.
[ ] 4. Each session tab has an editable title. Default titles are the agent runtime display name or `Terminal`.
[ ] 5. When a workspace is created with an associated default agent, the cockpit opens that agent automatically in a new session tab.
[ ] 6. The selected session occupies the rest of the column height.
[x] 7. Terminal keyboard shortcuts pass through to the active terminal by default. A small, named allow-list of cockpit shortcuts (see §Keyboard Shortcuts) is forwarded to the parent cockpit when xterm has focus; everything else is delivered to xterm unchanged.

## Inspector Tabs

[ ] 1. The inspector has at least two tabs: `Stats` and `Diff`. The tab strip is a compact pill-style picker that occupies only its own content width — never a half-panel-sized control.
[ ] 2. The `Stats` tab focuses on PR stats and PR check stats. It does **not** repeat workspace identity (name, branch) or workspace lifecycle/dirty state — those are already visible on the workspace card and stage header.
[~] 3. Slack threads are attached at workspace creation (the create-workspace modal accepts a Slack URL) and surfaced on the workspace card. The redesign removed the per-inspector Slack attach affordance; re-attaching after creation is not exposed today.
[x] 4. The Issue (Jira-style) chip is always rendered above the inspector body. When no issue is attached it shows a dashed empty-state "Attach Jira ticket" placeholder that toggles an inline form (key + URL); when one is attached it shows the key, optional title, and a sync-aware status pill (`cit-jira-status--unknown` fallback when the live status hasn't synced). If safe, attaching an issue can rename the workspace branch to `<issue-key>-<title-dashified>` (not yet implemented).
[ ] 5. The PR pill in the Stats tab is auto-detected from workspace git state and cycles through lifecycle colors (grey → yellow → green → red as appropriate). It is not manually attachable.
[ ] 6. The `Stats` tab shows the list of locally deployed apps for the current namespace, sourced from repo hooks. App chips show name, status colour, and clickable link.
[ ] 6a. When no apps hook is configured, the Deployed apps panel renders an explicit mock preview of how chips will appear and links directly to the repo settings where the hook is configured. It must never show a blank or non-actionable empty panel.
[ ] 7. Repo hooks must dynamically provide the list of services so monorepos with many services only show the subset touched by the workspace.
[ ] 8. The `Stats` tab surfaces the full PR check list with name and status, sourced from the version control provider, near the top of the tab.
[ ] 9. The `Diff` tab shows the changed files in the current workspace/PR with additions/deletions per file. Changed files are accessed here, not in Stats.
[ ] 10. The `Diff` tab is structured so a future full-screen *Human Review* mode (GitHub-style code review with comments visible to the agent) can be added without redesigning the panel.
[ ] 11. The Stats tab does not duplicate the per-session list — sessions live in the center column's tab strip only.

## Readiness

[ ] 1. Readiness has a concise state label.
[ ] 2. Readiness has a human-readable reason.
[ ] 3. Readiness lists blocking checks, failed hooks, missing providers, dirty files, waiting sessions, failed operations, and stale data.
[ ] 4. Readiness recommends the next operator action when one is available.
[ ] 5. Readiness links directly to the panel, action, operation, or provider that explains the state.
[ ] 6. Readiness updates when sessions, providers, git state, operations, hooks, or actions change.

## Workspace Detail

[ ] 1. Workspace detail has a readiness/next-action strip.
[ ] 2. Workspace detail shows active agent sessions and their attention state.
[ ] 3. Workspace detail shows PR/git/CI summary close to the workspace identity.
[ ] 4. Workspace detail shows apps, links, and executable actions as first-class controls.
[ ] 5. Workspace detail shows relevant failed/running operations near the workspace.
[ ] 6. Workspace detail shows activity that explains what changed and why.
[ ] 7. Workspace detail keeps the terminal, diff, review, apps/actions, and activity surfaces easy to reach.

## Attention States

[ ] 1. Empty repository state is explicit and actionable.
[ ] 2. Empty workspace state is explicit and actionable.
[ ] 3. No-runtime state is explicit.
[ ] 4. Runtime unhealthy state is explicit.
[ ] 5. Provider unhealthy state is explicit.
[ ] 6. Hook failed state is explicit.
[ ] 7. Stale provider data state is explicit.
[ ] 8. Waiting-human state is explicit.
[ ] 9. Waiting-review state is explicit.
[ ] 10. Failed operation state is explicit.
[ ] 11. Ready-to-merge or ready-to-deploy state is explicit when provider data supports it.

## Operator Actions

[ ] 1. The cockpit shows only actions that are valid for the selected workspace state.
[ ] 2. Primary actions are visually distinguished from secondary links.
[ ] 3. Destructive actions include confirmation and impact text.
[ ] 4. Side-effectful actions run through operations.
[ ] 5. Completed actions leave visible output or activity.

## Scratchpad

The cockpit's scratchpad view renders the per-workspace `scratchpad.md` (see B.7 for the storage format) as a stack of discrete, focusable blocks.

[ ] 1. Blocks render as sanitized markdown when not focused (headings, lists, bold/italic, inline + fenced code, links). Raw HTML is sanitized (scripts and inline event handlers removed); `<img>` tags are stripped in v1 since block content can originate from external MCP agents.
[ ] 2. Clicking a block enters inline edit mode with a `<textarea>` containing the raw markdown.
[ ] 3. Saving triggers: blur, Cmd/Ctrl-Enter (also exits edit mode), and ~1s debounce after the last keystroke. Esc cancels unsaved changes without a network call.
[ ] 4. Editing a block to empty/whitespace deletes the block (empty blocks are never persisted).
[ ] 5. A pinned composer at the bottom of the list is always visible. Cmd/Ctrl-Enter or blur-with-non-empty-content creates a new block at the end of the file. The list autoscrolls so the composer stays in view.
[ ] 6. Each block has a hover-visible delete affordance; deletion is optimistic and reversible via an undo toast.
[ ] 7. The version history sidebar continues to show whole-file snapshots, including the `migrate-to-blocks` entry that runs on the first read after upgrade.
[ ] 8. No drag-drop reorder, no typed blocks (code/todo/heading), no per-block diff in v1 — out of scope.

---

keywords: ade, cockpit, readiness, next action, workspace detail, operator, attention state, scratchpad, blocks
