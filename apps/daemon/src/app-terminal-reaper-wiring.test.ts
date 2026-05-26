import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeServer, createFixture as createFixtureBase, listen } from "./app-test-helpers.js";

// Pin createDaemonApp's wiring of startTerminalReaper: a future refactor that
// silently removes the call (or stops wiring its stop() into server close)
// would re-introduce the 29.8 GB tmux leak this branch fixed. The reaper
// itself is unit-tested in terminal-reaper.test.ts; this file only proves
// the daemon actually starts it.
//
// Mock has to be declared BEFORE the dynamic createDaemonApp import — vitest
// hoists vi.mock to the top of the module, so the mocked factory is in
// place by the time app.js loads terminal-reaper.js.
const stopSpy = vi.fn();
const factorySpy = vi.fn(() => ({ stop: stopSpy }));
vi.mock("./terminal-reaper.js", () => ({ startTerminalReaper: factorySpy }));

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  factorySpy.mockClear();
  stopSpy.mockClear();
});

function createFixture() {
  return createFixtureBase(dirs);
}

describe("createDaemonApp ↔ terminal reaper wiring", () => {
  it("invokes startTerminalReaper once and stops it on server close", async () => {
    const { createDaemonApp } = await import("./app.js");
    const fixture = createFixture();
    const { server } = await createDaemonApp(fixture);
    await listen(server);

    expect(factorySpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).not.toHaveBeenCalled();

    await closeServer(server);

    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});
