import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "e2e/**", "**/dist/**", "**/coverage/**"],
    pool: "forks",
    coverage: {
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["e2e/**", "dist/**", "coverage/**", "test-results/**", "playwright-report/**"],
    },
  },
});
