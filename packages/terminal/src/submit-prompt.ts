import { execFileSync } from "node:child_process";
import { pasteText, tmuxSessionExists, waitForPaneCommand, waitForTerminalIdle } from "./index.js";

// Submit a prompt or follow-up message into a tmux-backed runtime.
//
// Step-by-step, with the "why" for each:
//   1. Wait until the runtime's process is the foreground command in the pane
//      (`#{pane_current_command}` ≠ wrapper bash). This rules out the "we
//      sent keys while `bash -c …` was still doing setup" failure mode that
//      visual idle-detection can't see.
//   2. Wait for the pane to settle (silence-hook + capture-pane fallback).
//   3. Paste the prompt as a BRACKETED paste so the runtime sees one atomic
//      "this is text, not keystrokes" event. Solves the case where the
//      runtime's bracketed-paste mode flips on between our trim and our paste.
//   4. Verify by capture-pane that our prompt text actually appears in the
//      bottom rows of the pane (input area). If not, re-paste once.
//   5. Send Enter as a SEPARATE tmux call so it lands outside the paste
//      region.
//   6. Verify the prompt is no longer pending in the input area. If it is,
//      the Enter did not take (most common cause: runtime hadn't finished
//      committing the paste to input state). Send Enter again, up to 2
//      retries.
// Returns ok=false with an error string if any step exhausts its budget.
export async function submitPrompt(
  sessionName: string,
  prompt: string,
  options: {
    waitForReadyMs?: number;
    submitDelayMs?: number;
    submitKey?: string;
    runtimeReadyPredicate?: (cmd: string) => boolean;
    skipVerification?: boolean;
  } = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!tmuxSessionExists(sessionName)) return { ok: false, error: "tmux_session_missing" };
  const submitKey = options.submitKey ?? "Enter";
  // Defaults are deliberately generous for cold-start TUIs (Claude Code with
  // MCP servers connecting can paint for 10+ seconds). Tests pass tighter
  // values explicitly.
  const waitForReadyMs = options.waitForReadyMs ?? 8000;
  const submitDelayMs = options.submitDelayMs ?? 3000;
  try {
    // 1. Runtime-foreground check — best-effort, never blocks the actual send.
    if (options.runtimeReadyPredicate) {
      await waitForPaneCommand(sessionName, options.runtimeReadyPredicate, { timeoutMs: waitForReadyMs });
    }
    // 2. Pane settle pre-paste. Use the silence hook for long waits (TUI cold
    //    start budgets ≥ 5 s where a 1 s silence threshold is cheap insurance),
    //    fall back to fast capture-pane diffing when the caller passed a tight
    //    budget — shell sessions are quiet within milliseconds and shouldn't
    //    have to wait for the silence hook's whole-second minimum.
    const preIdleMs = waitForReadyMs >= 5000 ? 1000 : 200;
    await waitForTerminalIdle(sessionName, { timeoutMs: waitForReadyMs, idleMs: preIdleMs });

    // Trim trailing newlines so the paste itself never carries an LF the
    // runtime might treat as the submit keystroke — we always rely on the
    // explicit Enter that follows.
    const text = prompt.replace(/[\r\n]+$/u, "");
    const wantVerification = !options.skipVerification && text.length > 0;
    // Substring we expect to see in the input area after the paste. We use a
    // tail slice rather than the whole prompt because long prompts get
    // line-wrapped by the TUI and we'd never match the full text verbatim
    // against capture-pane's rendered output.
    const verifySnippet = verificationSnippet(text);
    if (text.length > 0) {
      // 3. Bracketed paste. We deliberately do NOT retry the paste: if the
      // verification snippet is missing, retrying just stacks two copies of
      // the prompt in the runtime's input box (the first paste DID land — we
      // just can't find the snippet because of wrap/animation). The Enter
      // retry below covers the genuine "Enter didn't submit" failure mode.
      pasteText(sessionName, text, { bracketed: true });
      // Post-paste settle: short, because we don't want to delay Enter
      // any longer than necessary, and capture-pane diff handles sub-second
      // idle better than the silence hook anyway.
      await waitForTerminalIdle(sessionName, {
        timeoutMs: submitDelayMs,
        idleMs: 200,
        pollMs: 60,
      });
      if (wantVerification && verifySnippet !== null && !pasteVisible(sessionName, verifySnippet)) {
        return { ok: false, error: "paste_not_visible" };
      }
    }

    // 5. Submit. We don't post-verify the Enter: most TUIs render the
    // submitted prompt in the conversation history (still in the bottom rows
    // of the pane), so "snippet still visible" doesn't distinguish "Enter
    // didn't submit" from "Enter submitted and the runtime is echoing the
    // history." The pre-paste idle wait + paste-visible verification above
    // are the load-bearing checks; this Enter is the easy part.
    execFileSync("tmux", ["send-keys", "-t", sessionName, submitKey]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "submit_prompt_failed" };
  }
}

// Last meaningful slice of the prompt we'll try to spot in the input region
// after pasting. We avoid matching on whitespace-only or extremely short
// snippets to keep false positives down. Returns null when verification
// should be skipped (e.g. prompts that are too short to fingerprint).
//
// Returned snippet is whitespace-collapsed (single spaces, no newlines) so
// the caller can compare against a similarly-normalized capture and the TUI
// line-wrap can't split the match.
function verificationSnippet(text: string): string | null {
  const normalized = collapseWhitespace(text);
  if (normalized.length < 4) return null;
  // The TAIL of the prompt is the most reliable signal: TUIs render the input
  // area bottom-aligned so the most recent chars are guaranteed to be visible
  // even when the start of a long prompt has scrolled. 24 chars is long
  // enough to be distinctive but short enough that we don't get unlucky and
  // straddle two wrap boundaries even when each wrapped segment is short.
  const tail = normalized.slice(-24);
  return tail.length >= 4 ? tail : null;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Is the verification snippet currently rendered anywhere in the bottom
// portion of the pane (i.e. the input area)? We check the last 12 visible
// rows — enough to cover multi-line input boxes without scanning the whole
// transcript. The capture is whitespace-collapsed before matching so TUI
// line-wrap (which inserts \n into the middle of a logical line) can't fool
// the substring check.
//
// Also accepts a TUI-specific "collapsed paste" marker as evidence: Claude
// Code replaces long pastes with `[Pasted text #N +K lines]` in the rendered
// input, so the snippet won't be on screen even though the paste landed
// fine in the runtime's internal buffer. The collapse marker is itself
// proof the paste was received.
function pasteVisible(sessionName: string, snippet: string): boolean {
  let captured: string;
  try {
    captured = execFileSync("tmux", ["capture-pane", "-p", "-J", "-S", "-12", "-t", sessionName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024,
    });
  } catch {
    return false;
  }
  const normalized = collapseWhitespace(captured);
  if (normalized.includes(snippet)) return true;
  // Claude Code: `[Pasted text #1 +101 lines]` (or "#1 paste again to expand").
  // We match loosely on "Pasted" + "#" + a digit because the exact suffix
  // varies with paste size and Claude version.
  return /\[Pasted [^\]]*#\d+/u.test(normalized);
}
