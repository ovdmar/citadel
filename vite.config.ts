import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname, 'web'),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4010'
    }
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true
  }
});
