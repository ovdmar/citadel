import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

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
      "/api": process.env.CITADEL_DAEMON_URL || "http://127.0.0.1:4010",
      "/events": process.env.CITADEL_DAEMON_URL || "http://127.0.0.1:4010",
      // ttyd-backed terminals: HTTP assets + WS upgrades both proxy through the daemon.
      "/terminals": {
        target: process.env.CITADEL_DAEMON_URL || "http://127.0.0.1:4010",
        ws: true,
        changeOrigin: true,
      },
      // Primary xterm/WebSocket terminal gateway.
      "/terminal": {
        target: (process.env.CITADEL_DAEMON_URL || "http://127.0.0.1:4010").replace(/^http/, "ws"),
        ws: true,
      },
    },
  },
});
