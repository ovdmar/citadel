import { describe, expect, it } from "vitest";
import { FUNNY_ADJECTIVES, FUNNY_ANIMALS, generateFunnyName } from "./funny-name.js";

describe("generateFunnyName", () => {
  it("returns a kebab-cased adjective-animal pair matching /^[a-z]+-[a-z]+$/", () => {
    const name = generateFunnyName();
    expect(name).toMatch(/^[a-z]+-[a-z]+$/);
    const [adjective, animal] = name.split("-");
    expect(FUNNY_ADJECTIVES).toContain(adjective);
    expect(FUNNY_ANIMALS).toContain(animal);
  });

  it("uses the injected rng deterministically", () => {
    // rng returns 0 → first adjective + first animal.
    const first = generateFunnyName(() => 0);
    expect(first).toBe(`${FUNNY_ADJECTIVES[0]}-${FUNNY_ANIMALS[0]}`);

    // rng returns 0.999… → last adjective + last animal (Math.floor(0.999*N) === N-1).
    const last = generateFunnyName(() => 0.999999);
    expect(last).toBe(`${FUNNY_ADJECTIVES.at(-1)}-${FUNNY_ANIMALS.at(-1)}`);
  });

  it("draws from the full dictionary across N=100 calls with random rng", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateFunnyName());
    // With a 30×30 = 900-name space and 100 draws, we expect well over 50
    // unique names by birthday-paradox math. 50 is a safe lower bound.
    expect(seen.size).toBeGreaterThan(50);
  });

  it("exposes non-empty dictionaries", () => {
    expect(FUNNY_ADJECTIVES.length).toBeGreaterThanOrEqual(20);
    expect(FUNNY_ANIMALS.length).toBeGreaterThanOrEqual(20);
    for (const word of [...FUNNY_ADJECTIVES, ...FUNNY_ANIMALS]) {
      expect(word).toMatch(/^[a-z]+$/);
    }
  });
});
