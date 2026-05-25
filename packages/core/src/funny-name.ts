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
  const item = arr[Math.floor(rng() * arr.length)];
  // Defensive: rng() === 1 would index past end. Math.floor(0.999..) === N-1
  // for any rng strictly in [0,1) so this only fires on a misbehaving rng.
  return (item ?? arr[arr.length - 1]) as T;
}

export function generateFunnyName(rng: () => number = Math.random): string {
  return `${pick(FUNNY_ADJECTIVES, rng)}-${pick(FUNNY_ANIMALS, rng)}`;
}
