import { describe, expect, it } from "vitest";
import { runCommandHook } from "./index.js";

describe("runCommandHook", () => {
  it("passes JSON input to command hooks and captures bounded output", async () => {
    const result = await runCommandHook(
      {
        id: "echo",
        event: "workspace.setup",
        command: "node",
        args: ["-e", "process.stdin.on('data', d => process.stdout.write(JSON.parse(d).name))"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        blocking: true,
      },
      { name: "citadel" },
    );

    expect(result.stdout).toBe("citadel");
  });
});
