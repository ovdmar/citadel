import { describe, expect, it } from "vitest";
import settingsSource from "../routes/settings.tsx?raw";
import { mcpUrlFromOrigin } from "./mcp-url.js";

describe("mcpUrlFromOrigin", () => {
  it("returns origin + /api/mcp/rpc", () => {
    expect(mcpUrlFromOrigin("http://localhost:5273")).toBe("http://localhost:5273/api/mcp/rpc");
  });

  it("appends /api/mcp/rpc to every origin and never injects the systemd port or loopback", () => {
    // Per-iteration positive assertion: catches a regression where the helper
    // returns the origin unchanged or appends the wrong path. The previous
    // assertion was negative-only and would have passed for `return origin`.
    const cases: Array<[string, string]> = [
      ["http://localhost:5273", "http://localhost:5273/api/mcp/rpc"],
      ["https://citadel.example", "https://citadel.example/api/mcp/rpc"],
      ["http://10.0.0.5:4209", "http://10.0.0.5:4209/api/mcp/rpc"],
    ];
    for (const [origin, expected] of cases) {
      const url = mcpUrlFromOrigin(origin);
      expect(url).toBe(expected);
      expect(url).not.toContain("4010");
      expect(url).not.toContain("127.0.0.1");
    }
  });

  it("documents the trailing-slash behavior (unreachable from window.location.origin per WHATWG, but the helper accepts any string)", () => {
    // window.location.origin per the WHATWG URL spec never includes a trailing
    // slash. If a future caller passes one anyway, the helper produces a
    // double-slash URL — accepted as documented behavior rather than silently
    // normalized, because origin normalization belongs at the URL spec layer.
    expect(mcpUrlFromOrigin("http://localhost:5273/")).toBe("http://localhost:5273//api/mcp/rpc");
  });
});

describe("settings.tsx", () => {
  it("uses mcpUrlFromOrigin to compute the MCP URL", () => {
    // Catches a typo refactor (e.g. `${window.location.origin}/api/mpc/rcp`)
    // that would leave Test 1 + the negative regex below both green while
    // silently breaking the cockpit. Together with the negative regex this
    // closes the loop on "the only producer of MCP URLs is the helper".
    expect(settingsSource).toMatch(/mcpUrlFromOrigin\s*\(\s*window\.location\.origin\s*\)/);
  });

  // Regression guard against the dead-branch SSR fallback that previously hard-coded
  // http://127.0.0.1:4010/api/mcp/rpc. The fallback was unreachable in the SPA but
  // would silently misroute under any future SSR/prerender pass. Source-level check
  // because a render-time assertion cannot reach dead branches. Uses Vite's ?raw
  // import (vitest-compatible) so the test stays inside apps/web's "no node: imports"
  // architecture boundary.
  //
  // Limitation: the regex only matches the contiguous literal. A future contributor
  // re-introducing the URL via string concatenation (e.g. `'127.0.0.1' + ':4010'`)
  // would bypass it. Accepted as adequate: such a re-introduction is implausible
  // outside of deliberate evasion, and a stricter regex risks false positives on
  // legitimate `:4010` references elsewhere (e.g. comments documenting the systemd
  // port). The positive assertion above is the primary guarantee of correct wiring.
  it("does not embed the systemd daemon URL as a literal", () => {
    // Sanity: confirm the ?raw import actually loaded the live source file,
    // not an empty string from a future tooling regression. Without this, an
    // empty `settingsSource` would pass the negative regex vacuously.
    expect(settingsSource).toContain("McpSection");
    expect(settingsSource.length).toBeGreaterThan(1000);
    expect(settingsSource).not.toMatch(/127\.0\.0\.1:4010/);
  });
});
