import { describe, expect, it } from "vitest";
import { agentNiceValue, agentResourcePrefixArgs } from "./resource-priority.js";

describe("agent resource priority", () => {
  it("wraps agent launches with idle IO and lower CPU priority by default", () => {
    expect(agentResourcePrefixArgs({ commandExists: () => true, env: {} })).toEqual([
      "ionice",
      "-c3",
      "nice",
      "-n",
      "10",
    ]);
  });

  it("can be disabled for environments that need unmodified agent launches", () => {
    expect(
      agentResourcePrefixArgs({
        commandExists: () => true,
        env: { CITADEL_AGENT_LOW_PRIORITY: "false" },
      }),
    ).toEqual([]);
  });

  it("omits unavailable wrappers instead of failing the launch", () => {
    expect(
      agentResourcePrefixArgs({
        commandExists: (command) => command === "nice",
        env: {},
      }),
    ).toEqual(["nice", "-n", "10"]);
  });

  it("supports disabling ionice while keeping nice", () => {
    expect(
      agentResourcePrefixArgs({
        commandExists: () => true,
        env: { CITADEL_AGENT_IONICE: "off", CITADEL_AGENT_NICE: "7" },
      }),
    ).toEqual(["nice", "-n", "7"]);
  });

  it("clamps nice values to the unprivileged priority-lowering range", () => {
    expect(agentNiceValue("-5")).toBe(0);
    expect(agentNiceValue("12")).toBe(12);
    expect(agentNiceValue("99")).toBe(19);
    expect(agentNiceValue("invalid")).toBe(10);
  });
});
