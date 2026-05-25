import { describe, expect, it } from "vitest";
import { appendTranscript } from "./append-transcript.js";

describe("appendTranscript", () => {
  it("returns the addition verbatim when existing is empty", () => {
    expect(appendTranscript("", "hello")).toBe("hello");
  });

  it("returns the addition verbatim when existing is whitespace-only", () => {
    expect(appendTranscript("   \n  ", "hello")).toBe("hello");
  });

  it("appends with a single space when existing has trimmed content", () => {
    expect(appendTranscript("hello", "world")).toBe("hello world");
  });

  it("trims trailing whitespace from existing before joining", () => {
    expect(appendTranscript("hello\n", "world")).toBe("hello world");
  });
});
