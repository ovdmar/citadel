import { describe, expect, it } from "vitest";
import { parseDuOutput, parsePsProcessTable } from "./system-resource-offenders.js";

describe("system resource offender parsing", () => {
  it("parses process table rows with command arguments intact", () => {
    const rows = parsePsProcessTable(`
      123  42.5  3.1  2048 node node /tmp/citadel/dist/main.js
      456   0.0  0.2   512 bash bash
      bad row
    `);

    expect(rows).toEqual([
      {
        pid: 123,
        command: "node",
        args: "node /tmp/citadel/dist/main.js",
        cpuPercent: 42.5,
        memoryPercent: 3.1,
        rssBytes: 2 * 1024 * 1024,
      },
      {
        pid: 456,
        command: "bash",
        args: "bash",
        cpuPercent: 0,
        memoryPercent: 0.2,
        rssBytes: 512 * 1024,
      },
    ]);
  });

  it("turns du rows into the top five disk offenders", () => {
    const offenders = parseDuOutput(`
      10 /tmp/citadel/small
      80 /tmp/citadel/big
      30 /tmp/citadel/mid
      20 /tmp/citadel/two
      40 /tmp/citadel/four
      50 /tmp/citadel/five
      60 /tmp/citadel/six
    `);

    expect(offenders.map((offender) => offender.label)).toEqual(["big", "six", "five", "four", "mid"]);
    expect(offenders[0]).toMatchObject({
      id: "path:/tmp/citadel/big",
      detail: "/tmp/citadel/big",
      pid: null,
      value: 80 * 1024,
      unit: "bytes",
    });
  });
});
