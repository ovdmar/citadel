import { describe, expect, it } from "vitest";
import { AgentRuntimeConfigSchema } from "./index.js";

describe("agent system prompt config", () => {
  it("accepts native system prompt argv mappings for custom runtimes", () => {
    const runtime = AgentRuntimeConfigSchema.parse({
      id: "custom",
      displayName: "Custom",
      command: "custom-agent",
      launchOptions: {
        systemPromptArgv: { argv: ["--system", "{value}"], valueEncoding: "raw" },
      },
    });

    expect(runtime.launchOptions?.systemPromptArgv).toEqual({
      argv: ["--system", "{value}"],
      valueEncoding: "raw",
    });
  });
});
