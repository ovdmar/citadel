import { describe, expect, it } from "vitest";
import { parseHookOutput, parseReviewSuggestionsOutput, runCommandHook } from "./index.js";

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

describe("parseReviewSuggestionsOutput", () => {
  it("returns null for empty stdout", () => {
    expect(parseReviewSuggestionsOutput("")).toBeNull();
    expect(parseReviewSuggestionsOutput("   \n\n")).toBeNull();
  });

  it("parses a valid payload and defaults missing fields", () => {
    const parsed = parseReviewSuggestionsOutput(
      JSON.stringify({
        suggestions: [{ id: "s", kind: "reviewer", label: "@alice" }],
      }),
    );
    expect(parsed?.suggestions).toHaveLength(1);
    expect(parsed?.generatedAt).toBeNull();
    expect(parsed?.metadata).toEqual({});
  });

  it("throws on malformed JSON", () => {
    expect(() => parseReviewSuggestionsOutput("{not json}")).toThrow();
  });

  it("throws on schema-invalid JSON", () => {
    expect(() => parseReviewSuggestionsOutput(JSON.stringify({ suggestions: "nope" }))).toThrow();
  });

  it("surfaces a truncation-style error when the leading edge is sliced", () => {
    const truncated = '{"suggestions":[{"id":"s","kind":"note","label":"x"}]}'.slice(5);
    expect(() => parseReviewSuggestionsOutput(truncated)).toThrow();
  });
});
