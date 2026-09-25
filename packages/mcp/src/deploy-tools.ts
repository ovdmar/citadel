import type { McpToolDefinition } from "./index.js";

export function deployedAppActionTool(name: "redeploy_app" | "undeploy_app", description: string, allAction: string) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      required: ["workspaceId"],
      properties: {
        workspaceId: { type: "string" },
        name: { type: "string", maxLength: 80, description: `App name from list_deployed_apps. Omit to ${allAction}.` },
      },
      additionalProperties: false,
    },
    destructive: true,
  } satisfies McpToolDefinition;
}
