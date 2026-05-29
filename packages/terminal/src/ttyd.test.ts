import { describe, expect, it } from "vitest";
import { buildAttachCommand } from "./ttyd.js";

describe("buildAttachCommand", () => {
  const session = "citadel_ws_abc12345";
  const cmd = buildAttachCommand(session, { enableMouse: true });

  it("includes the existing extended-keys + terminal-features lines (pre-existing decisions, unchanged)", () => {
    expect(cmd).toContain("set-option -s extended-keys on");
    expect(cmd).toContain("terminal-features");
    expect(cmd).toContain("xterm*:extkeys");
  });

  it("enables session-scoped mouse mode", () => {
    expect(cmd).toMatch(new RegExp(`set-option -t "${session}" mouse on`));
  });

  it("sets session-scoped history-limit to 50000", () => {
    expect(cmd).toMatch(new RegExp(`set-option -t "${session}" history-limit 50000`));
  });

  it("enables session-scoped set-clipboard so tmux copy-mode emits OSC 52", () => {
    expect(cmd).toMatch(new RegExp(`set-option -t "${session}" set-clipboard on`));
  });

  it("does NOT use the server-global `-g` flag for mouse / history-limit / set-clipboard", () => {
    // Server-global would affect every pane on the shared citadel tmux server.
    // Session-scoped `-t` keeps mouse handling aligned with the tab lifecycle.
    expect(cmd).not.toMatch(/set-option\s+-g\s+mouse/);
    expect(cmd).not.toMatch(/set-option\s+-g\s+history-limit/);
    expect(cmd).not.toMatch(/set-option\s+-g\s+set-clipboard/);
  });

  it('ends with `exec ... attach -t "<session>"` so attach is the final step', () => {
    expect(cmd).toMatch(/exec .*?tmux( -L \S+)? attach -t "[^"]+"$/);
  });

  it("emits the options BEFORE the attach (so they take effect during attach)", () => {
    const mouseIdx = cmd.indexOf("mouse on");
    const historyIdx = cmd.indexOf("history-limit");
    const clipboardIdx = cmd.indexOf("set-clipboard");
    // attach is the LAST step regardless of socket prefix.
    const attachIdx = cmd.search(/exec .*?tmux( -L \S+)? attach -t/);
    expect(mouseIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(-1);
    expect(clipboardIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(mouseIdx);
    expect(attachIdx).toBeGreaterThan(historyIdx);
    expect(attachIdx).toBeGreaterThan(clipboardIdx);
  });

  it("escapes embedded double quotes in the session name", () => {
    const escaped = buildAttachCommand('a"b', { enableMouse: true });
    expect(escaped).toContain('-t "a\\"b"');
    expect(escaped).toMatch(/set-option -t "a\\"b" mouse on/);
  });

  it("omits tmux mouse/copy-mode options when mouse handling is disabled for a runtime", () => {
    const disabled = buildAttachCommand(session, { enableMouse: false });
    expect(disabled).not.toContain("mouse on");
    expect(disabled).not.toContain("history-limit 50000");
    expect(disabled).not.toContain("set-clipboard on");
    expect(disabled).toMatch(/exec .*?tmux( -L \S+)? attach -t "[^"]+"$/);
  });

  it("always pairs `mouse on` with `set-clipboard on` (so drag-to-copy in plain panes still reaches the clipboard)", () => {
    // mouse on alone routes wheel events into tmux copy-mode, but copy-mode
    // selections need set-clipboard on to emit OSC 52 — without it, drag-to-copy
    // would silently fail to reach the system clipboard. Coupling regression check.
    if (cmd.includes("mouse on")) {
      expect(cmd).toContain("set-clipboard on");
    }
  });

  it("all option lines are guarded with `|| true` so a missing tmux feature does not break attach", () => {
    // Every set-option line should swallow failures so attach still runs on
    // older tmux versions that may not support a particular option.
    const lines = cmd.split(";").map((line) => line.trim());
    for (const line of lines) {
      if (/^tmux( -L \S+)? set-option/.test(line)) {
        expect(line, line).toContain("|| true");
      }
    }
  });
});
