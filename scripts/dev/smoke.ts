const baseUrl = process.env.CITADEL_BASE_URL || "http://127.0.0.1:4010";

for (const path of ["/api/health", "/api/state", "/api/mcp/status"]) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  const body = await response.json();
  console.log(`${path} ok`, JSON.stringify(body).slice(0, 240));
}
