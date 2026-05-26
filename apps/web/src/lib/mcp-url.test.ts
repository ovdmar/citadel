import { describe, expect, it } from "vitest";
import settingsSource from "../routes/settings.tsx?raw";
import { mcpUrlFromOrigin } from "./mcp-url.js";

describe("mcpUrlFromOrigin", () => {
  it("returns origin + /api/mcp/rpc", () => {
    expect(mcpUrlFromOrigin("http://localhost:5273")).toBe("http://localhost:5273/api/mcp/rpc");
  });

  it("never embeds the systemd port or loopback when the origin doesn't", () => {
    for (const origin of ["http://localhost:5273", "https://citadel.example", "http://10.0.0.5:4209"]) {
      const url = mcpUrlFromOrigin(origin);
      expect(url).not.toContain("4010");
      expect(url).not.toContain("127.0.0.1");
    }
  });
});

describe("settings.tsx", () => {
  // Regression guard against the dead-branch SSR fallback that previously hard-coded
  // http://127.0.0.1:4010/api/mcp/rpc. The fallback was unreachable in the SPA but
  // would silently misroute under any future SSR/prerender pass. Source-level check
  // because a render-time assertion cannot reach dead branches. We use Vite's ?raw
  // import (vitest-compatible) so the test stays inside apps/web's "no node: imports"
  // architecture boundary.
  it("does not embed the systemd daemon URL as a literal", () => {
    expect(settingsSource).not.toMatch(/127\.0\.0\.1:4010/);
  });
});
