import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, DEFAULT_PORT, centerOnDisplay, resolveDaemonTarget } from "./config.js";

describe("resolveDaemonTarget", () => {
  it("defaults to 127.0.0.1:4010 (the systemd long-term daemon)", () => {
    const target = resolveDaemonTarget({});
    expect(target.host).toBe(DEFAULT_HOST);
    expect(target.port).toBe(DEFAULT_PORT);
    expect(target.origin).toBe("http://127.0.0.1:4010");
    expect(target.quickCaptureUrl).toBe("http://127.0.0.1:4010/quick-capture");
    expect(target.newWorkspaceUrl).toBe("http://127.0.0.1:4010/?modal=new-workspace");
    expect(target.livenessUrl).toBe("http://127.0.0.1:4010/api/scratchpad");
  });

  it("honors CITADEL_HOST + CITADEL_PORT env vars", () => {
    const target = resolveDaemonTarget({ CITADEL_HOST: "10.0.0.5", CITADEL_PORT: "4150" });
    expect(target.host).toBe("10.0.0.5");
    expect(target.port).toBe(4150);
    expect(target.quickCaptureUrl).toBe("http://10.0.0.5:4150/quick-capture");
  });

  it("falls back to defaults when env values are empty / invalid", () => {
    expect(resolveDaemonTarget({ CITADEL_HOST: "  ", CITADEL_PORT: "" }).host).toBe(DEFAULT_HOST);
    expect(resolveDaemonTarget({ CITADEL_PORT: "not-a-number" }).port).toBe(DEFAULT_PORT);
    expect(resolveDaemonTarget({ CITADEL_PORT: "0" }).port).toBe(DEFAULT_PORT);
    expect(resolveDaemonTarget({ CITADEL_PORT: "-1" }).port).toBe(DEFAULT_PORT);
  });
});

describe("centerOnDisplay", () => {
  const display = { workArea: { x: 0, y: 0, width: 1440, height: 900 } };

  it("centers horizontally on the active display work area", () => {
    const { x, width } = centerOnDisplay(display);
    expect(width).toBe(640);
    expect(x).toBe(Math.round((1440 - 640) / 2));
  });

  it("places the window in the upper third of the display (Spotlight-style)", () => {
    const { y, height } = centerOnDisplay(display);
    expect(height).toBe(220);
    // 28% from the top of a 900px display = 252.
    expect(y).toBe(252);
  });

  it("respects workArea offsets (multi-monitor)", () => {
    const offset = { workArea: { x: 1440, y: 200, width: 1920, height: 1080 } };
    const { x, y } = centerOnDisplay(offset);
    expect(x).toBe(1440 + Math.round((1920 - 640) / 2));
    expect(y).toBe(200 + Math.round(1080 * 0.28));
  });
});
