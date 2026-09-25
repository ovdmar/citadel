const baseUrl = process.env.CITADEL_BASE_URL || "http://127.0.0.1:4010";

for (const path of ["/api/health", "/api/state", "/api/mcp/status"]) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const body = await response.json();
  console.log(`${path} ok`, JSON.stringify(body).slice(0, 240));
}

// Assert the review tools are surfaced via MCP status.
{
  const response = await fetch(`${baseUrl}/api/mcp/status`);
  const body = (await response.json()) as { tools?: string[] };
  const required = [
    "list_review_comments",
    "add_review_comment",
    "update_review_comment",
    "delete_review_comment",
    "request_review",
  ];
  const missing = required.filter((name) => !body.tools?.includes(name));
  if (missing.length) throw new Error(`Missing MCP review tools: ${missing.join(", ")}`);
  console.log(`mcp review tools ok: ${required.length} present`);
}

// Optional review-comments round-trip when a workspace id is provided.
const probeWorkspaceId = process.env.CITADEL_SMOKE_WORKSPACE_ID;
if (probeWorkspaceId) {
  const postResp = await fetch(`${baseUrl}/api/workspaces/${probeWorkspaceId}/review-comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "smoke-test comment" }),
  });
  if (!postResp.ok) throw new Error(`POST review-comments ${postResp.status}`);
  const created = (await postResp.json()) as { comment: { id: string; updatedAt: string } };
  const listResp = await fetch(`${baseUrl}/api/workspaces/${probeWorkspaceId}/review-comments`);
  if (!listResp.ok) throw new Error(`GET review-comments ${listResp.status}`);
  const listBody = (await listResp.json()) as { comments: unknown[] };
  if (listBody.comments.length < 1) throw new Error("expected at least one review comment after POST");
  const delResp = await fetch(`${baseUrl}/api/review-comments/${created.comment.id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ifUpdatedAtMatches: created.comment.updatedAt }),
  });
  if (delResp.status !== 204) throw new Error(`DELETE review-comments ${delResp.status}`);
  console.log("review-comments round-trip ok");
}
