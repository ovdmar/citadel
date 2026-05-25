# Pane fixture captures — agent status detection

Raw `tmux capture-pane -p` outputs captured from real Claude Code and Codex sessions launched via Citadel's MCP during the planning conversation. These are the seed fixtures for the pane-detection regex tests in `packages/runtimes/src/fixtures/`.

**Source:** captures done 2026-05-25 against:
- Claude Code v2.1.133 (Opus 4.7 1M context)
- OpenAI Codex CLI v0.130.0 (gpt-5.5)

## Files

### claude-code/
- `idle.txt` — Turn ended, no background work. `✻ Brewed for 4s`, mode line `⏵⏵ auto mode on (shift+tab to cycle)`.
- `running-mid-stream.txt` — Agent actively streaming response. Mode line ends with `· esc to interrupt`.
- `running-with-spinner-verb.txt` — Agent thinking, with verb-ing animation line (`· Pondering… (10s · ↓ 281 tokens)`). Mode line ends with `· esc to interrupt`.
- `running-with-monitor.txt` — Main turn ended but `Monitor` tool is still running. Completion line `✻ Baked for 7s · 1 monitor still running`. Mode line `⏵⏵ auto mode on · 1 monitor · ↓ to manage`.
- `running-with-shell.txt` — Main turn ended but `Bash run_in_background:true` still running. Completion line `✻ Baked for 5s · 1 shell still running`. Mode line `⏵⏵ auto mode on · 1 shell · ↓ to manage`.
- `running-with-local-agent.txt` — Subagent (Task tool) running. Mode line `⏵⏵ auto mode on · 1 local agent · esc to interrupt · ↓ to manage`. Also includes the agents list footer.
- `waiting-for-input-ask-question.txt` — AskUserQuestion UI rendered. Multi-choice block bounded by `─` lines. Final footer `Enter to select · ↑/↓ to navigate · Esc to cancel`.

### codex/
- `idle.txt` — Turn ended. Bottom status `gpt-5.5 default · <cwd>`.
- `running-mid-stream.txt` — Agent streaming response. Same visual as idle — distinguishable only via tmux activity timestamp.
- `waiting-for-input-sandbox.txt` — Sandbox approval prompt. Multi-choice block. Final footer `Press enter to confirm or esc to cancel`.

## Notes

- ScheduleWakeup / CronCreate produce NO persistent mode-line indicator (empirically verified — after `wakeup scheduled` completion the mode line showed only the in-flight `· 1 shell` from a separate background task). Therefore no fixture for "ScheduleWakeup pending" — there's nothing to match.
- Codex DOES have a Task tool (subagents) and `run_in_background:true` for Bash, but neither surfaces a persistent indicator in the pane (verified empirically). Codex sessions with background work in flight will be misclassified as `idle` — documented limitation.
- Cursor-agent NOT captured (binary unavailable on the dev machine). Plan defers to codex-fallback heuristic until a binary is available.

These fixtures should be copied byte-for-byte into `packages/runtimes/src/fixtures/<runtime>/<state>.txt` during implementation Step 3. Adapter regex unit tests load each fixture and assert the adapter's `observe()` returns the documented status.
