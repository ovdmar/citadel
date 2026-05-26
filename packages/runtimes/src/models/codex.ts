import type { RuntimeModelListerResult } from "./index.js";

// codex CLI does not expose model selection (supportsModelSelection: false in
// the runtimes registry). Return a single default entry so the UI never shows
// an empty list. Update this manually when codex gains a model picker.
export async function fetchCodexModels(_input: {
  command: string;
  args?: string[];
}): Promise<RuntimeModelListerResult> {
  return {
    models: [{ id: "gpt-5.5", displayName: "GPT-5.5", isDefault: true }],
  };
}
