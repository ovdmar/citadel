import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xterm")) return "terminal";
          if (id.includes("@tanstack")) return "tanstack";
          if (id.includes("react") || id.includes("react-dom")) return "react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4337",
      "/events": "http://127.0.0.1:4337",
      "/terminal": {
        target: "ws://127.0.0.1:4337",
        ws: true,
      },
    },
  },
});
