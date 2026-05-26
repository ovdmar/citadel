import { describe, expect, it } from "vitest";
import { buildAttachCommand } from "./ttyd.js";

describe("buildAttachCommand", () => {
  const session = "citadel_ws_abc12345";
  const cmd = buildAttachCommand(session);

  it("includes the existing extended-keys + terminal-features lines (pre-existing decisions, unchanged)", () => {
    expect(cmd).toContain("set-option -s extended-keys on");
    expect(cmd).toContain("terminal-features");
    expect(cmd).toContain("xterm*:extkeys");
  });

  it("enables session-scoped mouse mode", () => {
    expect(cmd).toContain(`tmux set-option -t "${session}" mouse on`);
  });

  it("sets session-scoped history-limit to 50000", () => {
    expect(cmd).toContain(`tmux set-option -t "${session}" history-limit 50000`);
  });

  it("enables session-scoped set-clipboard so tmux copy-mode emits OSC 52", () => {
    expect(cmd).toContain(`tmux set-option -t "${session}" set-clipboard on`);
  });

  it("does NOT use the server-global `-g` flag for mouse / history-limit / set-clipboard", () => {
    // Server-global would pollute the operator's tmux sessions outside Citadel
    // because Citadel uses the user's default tmux socket. Regression check.
    expect(cmd).not.toMatch(/set-option\s+-g\s+mouse/);
    expect(cmd).not.toMatch(/set-option\s+-g\s+history-limit/);
    expect(cmd).not.toMatch(/set-option\s+-g\s+set-clipboard/);
  });

  it('ends with `exec tmux attach -t "<session>"` so attach is the final step', () => {
    expect(cmd).toMatch(/exec tmux attach -t "[^"]+"$/);
    expect(cmd.endsWith(`exec tmux attach -t "${session}"`)).toBe(true);
  });

  it("emits the options BEFORE the attach (so they take effect during attach)", () => {
    const mouseIdx = cmd.indexOf("mouse on");
    const historyIdx = cmd.indexOf("history-limit");
    const clipboardIdx = cmd.indexOf("set-clipboard");
    const attachIdx = cmd.indexOf("exec tmux attach");
    expect(mouseIdx).toBeGreaterThan(-1);
    expect(historyIdx).toBeGreaterThan(-1);
    expect(clipboardIdx).toBeGreaterThan(-1);
    expect(attachIdx).toBeGreaterThan(mouseIdx);
    expect(attachIdx).toBeGreaterThan(historyIdx);
    expect(attachIdx).toBeGreaterThan(clipboardIdx);
  });

  it("escapes embedded double quotes in the session name", () => {
    const escaped = buildAttachCommand('a"b');
    expect(escaped).toContain('-t "a\\"b"');
    expect(escaped).toContain('set-option -t "a\\"b" mouse on');
  });

  it("all option lines are guarded with `|| true` so a missing tmux feature does not break attach", () => {
    // Every set-option line should swallow failures so attach still runs on
    // older tmux versions that may not support a particular option.
    const lines = cmd.split(";").map((line) => line.trim());
    for (const line of lines) {
      if (line.startsWith("tmux set-option")) {
        expect(line, line).toContain("|| true");
      }
    }
  });
});
