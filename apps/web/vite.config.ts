import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const daemonUrl = process.env.CITADEL_DAEMON_URL || "http://127.0.0.1:4010";
const e2eRunId = process.env.CITADEL_E2E_RUN_ID || process.env.CITADEL_PLAYWRIGHT_RUN_ID;
const e2eHeaders = e2eRunId ? { "X-Citadel-E2E-Run-Id": e2eRunId } : undefined;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("react") || id.includes("react-dom")) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: Number(process.env.CITADEL_WEB_PORT) || 5173,
    proxy: {
      "/api": { target: daemonUrl, headers: e2eHeaders },
      "/events": { target: daemonUrl, headers: e2eHeaders },
      // xterm/WebSocket terminal gateway.
      "/terminal": {
        target: daemonUrl.replace(/^http/, "ws"),
        headers: e2eHeaders,
        ws: true,
      },
    },
  },
});
