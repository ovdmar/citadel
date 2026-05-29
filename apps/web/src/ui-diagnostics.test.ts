// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { installUiDiagnostics, resetUiDiagnosticsForTests } from "./ui-diagnostics.js";

describe("installUiDiagnostics", () => {
  beforeEach(() => {
    resetUiDiagnosticsForTests();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
  });

  it("posts page lifecycle events to daemon diagnostics", async () => {
    installUiDiagnostics();

    expect(fetch).toHaveBeenCalledWith(
      "/api/diagnostics/client-event",
      expect.objectContaining({
        method: "POST",
        keepalive: false,
      }),
    );

    window.dispatchEvent(pageTransitionEvent("pagehide", true));

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/diagnostics/client-event",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
      }),
    );
    const body = JSON.parse(String((fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]?.body));
    expect(body).toMatchObject({ event: "page.pagehide", persisted: true });
  });
});

function pageTransitionEvent(type: string, persisted: boolean) {
  const event = new Event(type);
  Object.defineProperty(event, "persisted", { value: persisted });
  return event as PageTransitionEvent;
}
