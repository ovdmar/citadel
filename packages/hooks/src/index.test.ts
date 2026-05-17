import { describe, expect, it } from "vitest";
import { parseHookOutput, runCommandHook } from "./index.js";

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

  it("rejects failed hooks with captured output", async () => {
    await expect(
      runCommandHook(
        {
          id: "fail",
          event: "workspace.teardown",
          command: "node",
          args: ["-e", "process.stderr.write('teardown failed'); process.exit(7)"],
          cwd: process.cwd(),
          timeoutMs: 5000,
          blocking: true,
        },
        { name: "citadel" },
      ),
    ).rejects.toThrow("teardown failed");
  });

  it("terminates hooks that exceed their timeout", async () => {
    await expect(
      runCommandHook(
        {
          id: "timeout",
          event: "workspace.setup",
          command: "node",
          args: ["-e", "setTimeout(() => {}, 5000)"],
          cwd: process.cwd(),
          timeoutMs: 50,
          blocking: true,
        },
        { name: "citadel" },
      ),
    ).rejects.toThrow("Hook timed out");
  });

  it("parses structured hook output for links and actions", () => {
    expect(
      parseHookOutput(
        JSON.stringify({
          links: [{ label: "Preview", url: "https://example.test/preview", kind: "preview" }],
          actions: [{ id: "redeploy", label: "Redeploy", url: "https://example.test/deploy" }],
        }),
      ),
    ).toMatchObject({ links: [{ label: "Preview" }], actions: [{ id: "redeploy" }] });
  });
});
