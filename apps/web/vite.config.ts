import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
