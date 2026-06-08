import type { PrMergeResponse, PrMergeStrategy } from "@citadel/contracts/pr-routes";
import { gh } from "./gh-runner.js";

type GhRunner = (args: string[]) => Promise<string>;

// Internal seam: tests inject a fake runner; production calls the shared gh
// runner. NO --delete-branch is ever passed — branch deletion is a separate
// opt-in flow that's intentionally not part of the merge action.
export async function mergePr(
  input: { rootPath: string; number: number; strategy: PrMergeStrategy; admin?: boolean },
  runner?: GhRunner,
): Promise<PrMergeResponse> {
  const run: GhRunner = runner ?? ((args) => gh(input.rootPath, args));
  const args = ["pr", "merge", String(input.number), `--${input.strategy}`];
  if (input.admin === true) args.push("--admin");
  try {
    await run(args);
    return { ok: true };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: classifyMergeFailure(detail), detail };
  }
}

function classifyMergeFailure(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("not mergeable") || lower.includes("merge conflict")) return "not_mergeable";
  if (lower.includes("not authorized") || lower.includes("authentication")) return "gh_auth";
  if (lower.includes("not allowed") || lower.includes("disabled")) return "strategy_disallowed";
  return "gh_error";
}
