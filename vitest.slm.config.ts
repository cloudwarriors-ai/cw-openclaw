import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config.ts";

const baseTest = (
  baseConfig as {
    test?: {
      testTimeout?: number;
      hookTimeout?: number;
      pool?: "forks" | "threads";
      maxWorkers?: number;
      setupFiles?: string[];
      exclude?: string[];
    };
  }
).test ?? { testTimeout: 120_000, hookTimeout: 120_000, pool: "forks", maxWorkers: 4 };
const isBunRuntime = typeof Bun !== "undefined";
const include = [
  "extensions/slm-pipeline/**/*.test.ts",
  "extensions/slm-supervisor/**/*.test.ts",
  "packages/memory-server/src/**/*.test.ts",
  "apps/slm-dashboard/src/server/**/*.test.ts",
];
if (!isBunRuntime) {
  include.unshift("extensions/memory-pgvector/**/*.test.ts");
}

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    setupFiles: [],
    include,
    exclude: [
      ...(baseTest.exclude ?? []),
      "**/*.e2e.test.ts",
      "**/*.live.test.ts",
      ...(isBunRuntime
        ? [
            "extensions/memory-pgvector/**/*.test.ts",
            "apps/slm-dashboard/src/server/gateway-client.test.ts",
          ]
        : []),
    ],
  },
});
