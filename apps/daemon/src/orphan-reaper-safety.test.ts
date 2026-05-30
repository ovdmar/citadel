import { describe, expect, it } from "vitest";
import { shouldReapTmuxOrphans } from "./orphan-reaper-safety.js";

describe("shouldReapTmuxOrphans", () => {
  it("blocks ad-hoc sandbox daemons from reaping the shared citadel socket", () => {
    expect(
      shouldReapTmuxOrphans({
        daemonPort: 14012,
        explicitDataDirOverride: true,
        ownsTmuxSocket: false,
      }),
    ).toBe(false);
  });

  it("allows daemons that own an isolated tmux socket to reap their own orphans", () => {
    expect(
      shouldReapTmuxOrphans({
        daemonPort: 14012,
        explicitDataDirOverride: true,
        ownsTmuxSocket: true,
      }),
    ).toBe(true);
  });

  it("allows the installed daemon default path to maintain the shared socket", () => {
    expect(
      shouldReapTmuxOrphans({
        daemonPort: 4010,
        explicitDataDirOverride: false,
        ownsTmuxSocket: false,
      }),
    ).toBe(true);
  });

  it("requires an explicit override for non-default shared-socket maintenance", () => {
    expect(
      shouldReapTmuxOrphans({
        daemonPort: 14012,
        explicitDataDirOverride: true,
        ownsTmuxSocket: false,
        allowSharedTmuxReaper: "1",
      }),
    ).toBe(true);
  });

  it("honors the disable flag even for owned sockets", () => {
    expect(
      shouldReapTmuxOrphans({
        daemonPort: 14012,
        explicitDataDirOverride: true,
        ownsTmuxSocket: true,
        disableOrphanReaper: "1",
      }),
    ).toBe(false);
  });
});
