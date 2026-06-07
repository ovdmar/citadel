import { describe, expect, it } from "vitest";
import { mergePr } from "./index.js";

describe("mergePr", () => {
  it("runs normal merges without admin bypass or branch deletion", async () => {
    const calls: string[][] = [];
    const result = await mergePr({ rootPath: "/tmp/x", number: 7, strategy: "squash" }, async (args) => {
      calls.push(args);
      return "";
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["pr", "merge", "7", "--squash"]]);
    expect(calls[0]).not.toContain("--admin");
    expect(calls[0]).not.toContain("--delete-branch");
  });

  it("adds admin bypass only when requested", async () => {
    const calls: string[][] = [];
    const result = await mergePr(
      { rootPath: "/tmp/x", number: 8, strategy: "merge", admin: true },
      async (args) => {
        calls.push(args);
        return "";
      },
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([["pr", "merge", "8", "--merge", "--admin"]]);
    expect(calls[0]).not.toContain("--delete-branch");
  });
});
