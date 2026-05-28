// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { isTtydReconnectPromptVisible } from "./terminal-pane.js";

function iframeWithBody(html: string): HTMLIFrameElement {
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) throw new Error("iframe contentDocument unavailable");
  doc.body.innerHTML = html;
  return iframe;
}

describe("isTtydReconnectPromptVisible", () => {
  it("detects ttyd's persistent reconnect overlay", () => {
    const iframe = iframeWithBody('<div class="xterm"><div>Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("detects reconnect button overlays from ttyd variants", () => {
    const iframe = iframeWithBody('<main><button type="button">Reconnect</button></main>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(true);
  });

  it("ignores normal terminal output mentioning reconnect", () => {
    const iframe = iframeWithBody(
      '<div class="xterm"><div class="xterm-screen"><span>run reconnect-database when ready</span></div></div>',
    );

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });

  it("ignores hidden reconnect overlays", () => {
    const iframe = iframeWithBody('<div class="xterm"><div style="display: none">Press ⏎ to Reconnect</div></div>');

    expect(isTtydReconnectPromptVisible(iframe)).toBe(false);
  });
});
