import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const workspacePackages = {
  "@citadel/config": "./packages/config/src/index.ts",
  "@citadel/contracts": "./packages/contracts/src/index.ts",
  "@citadel/core": "./packages/core/src/index.ts",
  "@citadel/db": "./packages/db/src/index.ts",
  "@citadel/hooks": "./packages/hooks/src/index.ts",
  "@citadel/mcp": "./packages/mcp/src/index.ts",
  "@citadel/operations": "./packages/operations/src/index.ts",
  "@citadel/providers": "./packages/providers/src/index.ts",
  "@citadel/runtimes": "./packages/runtimes/src/index.ts",
  "@citadel/terminal": "./packages/terminal/src/index.ts",
  "@citadel/testing": "./packages/testing/src/index.ts",
  "@citadel/ui": "./packages/ui/src/index.ts",
} as const;

const workspaceAliases = Object.entries(workspacePackages).map(([find, source]) => ({
  find: new RegExp(`^${find.replace("/", "\\/")}$`),
  replacement: fileURLToPath(new URL(source, import.meta.url)),
}));

const contractsSrc = fileURLToPath(new URL("./packages/contracts/src", import.meta.url));

export default defineConfig({
  resolve: {
    alias: [...workspaceAliases, { find: /^@citadel\/contracts\/(.+)$/, replacement: `${contractsSrc}/$1.ts` }],
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/src/**/*.test.tsx",
      "apps/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
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
