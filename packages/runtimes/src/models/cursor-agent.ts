import type { RuntimeModelListerResult } from "./index.js";

// cursor-agent doesn't advertise model selection; ship a single default.
export async function fetchCursorAgentModels(_input: {
  command: string;
  args?: string[];
}): Promise<RuntimeModelListerResult> {
  return { models: [{ id: "default", isDefault: true }] };
}
