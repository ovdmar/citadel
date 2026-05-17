import { describe, expect, it } from "vitest";
import { commandHealth } from "./index.js";

describe("commandHealth", () => {
  it("reports disabled providers as unavailable", async () => {
    const health = await commandHealth({
      id: "disabled",
      displayName: "Disabled",
      kind: "ci",
      command: "missing-command",
      args: [],
      enabled: false,
    });

    expect(health.status).toBe("unavailable");
  });

  it("reports successful shell providers as healthy", async () => {
    const health = await commandHealth({
      id: "node",
      displayName: "Node",
      kind: "version-control",
      command: "node",
      args: ["-e", "process.exit(0)"],
      enabled: true,
    });

    expect(health.status).toBe("healthy");
  });
});
