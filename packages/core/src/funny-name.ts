// Two-token workspace-name generator used when the operator does not
// supply one at creation time. Memorable, kebab-cased, dictionary-bounded
// so a Vitest assertion can verify shape and coverage.

export const FUNNY_ADJECTIVES = [
  "ambling",
  "breezy",
  "chipper",
  "clever",
  "cosy",
  "dapper",
  "earnest",
  "feisty",
  "frisky",
  "gentle",
  "grumpy",
  "hasty",
  "jolly",
  "lively",
  "mellow",
  "merry",
  "mighty",
  "nimble",
  "perky",
  "plucky",
  "quirky",
  "rascal",
  "rowdy",
  "snappy",
  "spry",
  "stoic",
  "sturdy",
  "swift",
  "wily",
  "zesty",
] as const;

export const FUNNY_ANIMALS = [
  "badger",
  "beaver",
  "cat",
  "chinchilla",
  "ferret",
  "finch",
  "fox",
  "gecko",
  "hare",
  "hedgehog",
  "heron",
  "ibex",
  "lemur",
  "lynx",
  "magpie",
  "marmot",
  "newt",
  "otter",
  "owl",
  "pangolin",
  "puffin",
  "quokka",
  "raccoon",
  "raven",
  "robin",
  "seal",
  "stoat",
  "tapir",
  "weasel",
  "wombat",
] as const;

function pick<T>(arr: readonly T[], rng: () => number): T {
  // Contract: `rng` returns a value in [0, 1) per `Math.random()`.
  return arr[Math.floor(rng() * arr.length)] as T;
}

export function generateFunnyName(rng: () => number = Math.random): string {
  return `${pick(FUNNY_ADJECTIVES, rng)}-${pick(FUNNY_ANIMALS, rng)}`;
}
