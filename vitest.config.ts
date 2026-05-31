import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**", "**/dist/**", "**/coverage/**"],
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["e2e/**", "dist/**", "coverage/**", "test-results/**", "playwright-report/**"],
    },
  },
});
