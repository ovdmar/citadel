import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const contractsSrc = fileURLToPath(new URL("./packages/contracts/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@citadel\/contracts$/, replacement: `${contractsSrc}/index.ts` },
      { find: /^@citadel\/contracts\/(.+)$/, replacement: `${contractsSrc}/$1.ts` },
    ],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: ["**/node_modules/**", "e2e/**", "**/dist/**", "**/coverage/**"],
    setupFiles: ["./vitest.setup.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
    coverage: {
      include: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
      exclude: ["e2e/**", "dist/**", "coverage/**", "test-results/**", "playwright-report/**"],
    },
  },
});
