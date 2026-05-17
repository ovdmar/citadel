import { describe, expect, it } from "vitest";
import { listRuntimeHealth, shellQuote } from "./index.js";

describe("runtime health", () => {
  it("marks available commands as healthy", () => {
    const runtimes = listRuntimeHealth([{ id: "node", displayName: "Node", command: "node", args: [] }]);

    expect(runtimes[0]?.health).toBe("healthy");
    expect(runtimes[0]?.capabilities.supportsShell).toBe(true);
  });

  it("quotes shell command names safely", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
